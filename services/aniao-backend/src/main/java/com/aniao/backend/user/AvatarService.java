package com.aniao.backend.user;

import com.aniao.backend.common.ApiException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;

@Service
public class AvatarService {
	private static final long MAX_BYTES = 2L * 1024 * 1024;
	private static final Set<String> ALLOWED_TYPES = Set.of("image/png", "image/jpeg", "image/webp", "image/gif");
	private static final String[] COLORS = {"#3f6f5f", "#6b5b95", "#b06a4a", "#4a7399", "#8a5a6b", "#6d7f43"};

	private final UserRepository users;
	private final UserAvatarRepository avatars;

	@PersistenceContext
	private EntityManager entityManager;

	public AvatarService(UserRepository users, UserAvatarRepository avatars) {
		this.users = users;
		this.avatars = avatars;
	}

	@Transactional
	public UserAvatarView upload(long userId, MultipartFile file) {
		if (file == null || file.isEmpty()) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "empty_avatar", "请选择头像图片");
		}
		String contentType = file.getContentType() == null ? "" : file.getContentType().toLowerCase(Locale.ROOT);
		if (!ALLOWED_TYPES.contains(contentType)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_avatar_type", "头像仅支持 PNG、JPEG、WebP 或 GIF");
		}
		if (file.getSize() > MAX_BYTES) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "avatar_too_large", "头像不能超过 2MB");
		}
		AppUser user = users.findById(userId)
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "not_found", "用户不存在"));
		try {
			byte[] data = file.getBytes();
			UserAvatar avatar = avatars.findById(userId).orElse(null);
			if (avatar == null) entityManager.persist(new UserAvatar(user, data, contentType));
			else avatar.replace(data, contentType);
			return new UserAvatarView("/api/avatars/" + userId);
		} catch (IOException exception) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "avatar_read_failed", "头像读取失败");
		}
	}

	@Transactional
	public void remove(long userId) {
		avatars.deleteById(userId);
	}

	@Transactional(readOnly = true)
	public AvatarContent get(long userId) {
		AppUser user = users.findById(userId)
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "not_found", "用户不存在"));
		UserAvatar avatar = avatars.findById(userId).orElse(null);
		if (avatar != null) return new AvatarContent(avatar.getData(), avatar.getContentType());
		return new AvatarContent(defaultSvg(user), "image/svg+xml");
	}

	private byte[] defaultSvg(AppUser user) {
		String name = user.getDisplayName() == null || user.getDisplayName().isBlank()
				? user.getUsername()
				: user.getDisplayName();
		String initial = name.substring(0, Math.min(2, name.length())).toUpperCase(Locale.ROOT)
				.replace("&", "&amp;")
				.replace("<", "&lt;")
				.replace(">", "&gt;");
		String color = COLORS[Math.floorMod(user.getUsername().hashCode(), COLORS.length)];
		String svg = """
				<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
				<rect width="128" height="128" rx="28" fill="%s"/>
				<text x="64" y="80" text-anchor="middle" font-family="Arial, sans-serif" font-size="48"
				font-weight="600" fill="#ffffff">%s</text>
				</svg>
				""".formatted(color, initial);
		return svg.getBytes(StandardCharsets.UTF_8);
	}

	public record UserAvatarView(String avatarUrl) {
	}

	public record AvatarContent(byte[] data, String contentType) {
	}
}
