package com.aniao.backend.auth;

import com.aniao.backend.user.AppUser;
import com.aniao.backend.user.Role;
import com.aniao.backend.user.UserRepository;
import com.aniao.backend.user.UserStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.util.Locale;

@Component
public class AdminBootstrap implements CommandLineRunner {
	private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

	private final UserRepository users;
	private final PasswordEncoder encoder;

	@Value("${app.admin.username:admin}")
	private String username;

	@Value("${app.admin.password:}")
	private String password;

	public AdminBootstrap(UserRepository users, PasswordEncoder encoder) {
		this.users = users;
		this.encoder = encoder;
	}

	@Override
	public void run(String... args) {
		if (password == null || password.isBlank()) return;
		String name = username.trim().toLowerCase(Locale.ROOT);
		if (name.length() < 3) throw new IllegalStateException("ANIAO_ADMIN_USERNAME must be at least 3 characters");
		AppUser user = users.findByUsername(name).orElse(null);
		if (user == null) {
			user = new AppUser(name, encoder.encode(password), "Administrator", Role.ADMIN);
			users.save(user);
			log.info("Bootstrap administrator created: {}", name);
			return;
		}
		boolean changed = false;
		if (user.getRole() != Role.ADMIN) {
			user.setRole(Role.ADMIN);
			changed = true;
		}
		if (user.getStatus() != UserStatus.ACTIVE) {
			user.setStatus(UserStatus.ACTIVE);
			changed = true;
		}
		if (changed) users.save(user);
	}
}
