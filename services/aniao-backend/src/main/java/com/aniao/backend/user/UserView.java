package com.aniao.backend.user;

import java.time.Instant;

public record UserView(
		long id,
		String username,
		String displayName,
		Role role,
		UserStatus status,
		Instant createdAt,
		Instant lastLoginAt,
		String avatarUrl) {
	public static UserView from(AppUser user) {
		return new UserView(
				user.getId(),
				user.getUsername(),
				user.getDisplayName(),
				user.getRole(),
				user.getStatus(),
				user.getCreatedAt(),
				user.getLastLoginAt(),
				"/api/avatars/" + user.getId());
	}
}
