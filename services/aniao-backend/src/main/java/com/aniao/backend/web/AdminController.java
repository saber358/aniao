package com.aniao.backend.web;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.common.PageView;
import com.aniao.backend.feedback.FeedbackService;
import com.aniao.backend.feedback.FeedbackStatus;
import com.aniao.backend.usage.UsageService;
import com.aniao.backend.user.Role;
import com.aniao.backend.user.UserService;
import com.aniao.backend.user.UserStatus;
import com.aniao.backend.user.UserView;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
	private final UserService users;
	private final UsageService usage;
	private final FeedbackService feedback;

	public AdminController(UserService users, UsageService usage, FeedbackService feedback) {
		this.users = users;
		this.usage = usage;
		this.feedback = feedback;
	}

	@GetMapping("/users")
	List<UserView> users(
			@RequestParam(required = false) String query,
			@RequestParam(required = false) UserStatus status) {
		return users.list(query, status);
	}

	@PatchMapping("/users/{id}/status")
	UserView updateStatus(
			@AuthenticationPrincipal UserPrincipal actor,
			@PathVariable long id,
			@Valid @RequestBody UpdateStatusRequest request) {
		return users.updateStatus(actor, id, request.status());
	}

	@PatchMapping("/users/{id}/role")
	UserView updateRole(
			@AuthenticationPrincipal UserPrincipal actor,
			@PathVariable long id,
			@Valid @RequestBody UpdateRoleRequest request) {
		return users.updateRole(actor, id, request.role());
	}

	@GetMapping("/usage/summary")
	UsageService.AdminUsageSummary usageSummary(
			@RequestParam(required = false) Long userId,
			@RequestParam(required = false) Instant from,
			@RequestParam(required = false) Instant to) {
		return usage.adminSummary(userId, from, to);
	}

	@GetMapping("/feedback")
	PageView<FeedbackService.FeedbackView> feedback(
			@RequestParam(defaultValue = "0") int page,
			@RequestParam(defaultValue = "30") int size) {
		return feedback.all(page, size);
	}

	@PatchMapping("/feedback/{id}")
	FeedbackService.FeedbackView updateFeedback(
			@PathVariable long id,
			@Valid @RequestBody UpdateFeedbackRequest request) {
		return feedback.updateStatus(id, request.status());
	}

	public record UpdateStatusRequest(@NotNull UserStatus status) {
	}

	public record UpdateRoleRequest(@NotNull Role role) {
	}

	public record UpdateFeedbackRequest(@NotNull FeedbackStatus status) {
	}
}
