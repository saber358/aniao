package com.aniao.backend.user;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.common.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;

@Service
public class UserService {
	private final UserRepository users;

	public UserService(UserRepository users) {
		this.users = users;
	}

	@Transactional(readOnly = true)
	public UserView me(long id) {
		return UserView.from(find(id));
	}

	@Transactional(readOnly = true)
	public List<UserView> list(String query, UserStatus status) {
		String search = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
		return users.findAll().stream()
				.filter(user -> status == null || user.getStatus() == status)
				.filter(user -> search.isEmpty()
						|| user.getUsername().contains(search)
						|| user.getDisplayName().toLowerCase(Locale.ROOT).contains(search))
				.sorted(Comparator.comparing(AppUser::getCreatedAt).reversed())
				.map(UserView::from)
				.toList();
	}

	@Transactional
	public UserView updateStatus(UserPrincipal actor, long targetId, UserStatus status) {
		AppUser target = find(targetId);
		if (actor.id() == targetId && status == UserStatus.DISABLED) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "cannot_disable_self", "不能禁用当前登录账号");
		}
		target.setStatus(status);
		users.save(target);
		return UserView.from(target);
	}

	@Transactional
	public UserView updateRole(UserPrincipal actor, long targetId, Role role) {
		AppUser target = find(targetId);
		if (actor.id() == targetId && role != Role.ADMIN) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "cannot_demote_self", "不能取消当前登录账号的管理员权限");
		}
		if (target.getRole() == Role.ADMIN && role != Role.ADMIN && users.countByRole(Role.ADMIN) <= 1) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "last_admin", "至少需要保留一个管理员");
		}
		target.setRole(role);
		users.save(target);
		return UserView.from(target);
	}

	private AppUser find(long id) {
		return users.findById(id)
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "not_found", "用户不存在"));
	}
}
