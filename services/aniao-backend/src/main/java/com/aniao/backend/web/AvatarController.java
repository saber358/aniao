package com.aniao.backend.web;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.user.AvatarService;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api")
public class AvatarController {
	private final AvatarService avatars;

	public AvatarController(AvatarService avatars) {
		this.avatars = avatars;
	}

	@PostMapping(value = "/me/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
	AvatarService.UserAvatarView upload(
			@AuthenticationPrincipal UserPrincipal principal,
			@RequestPart("file") MultipartFile file) {
		return avatars.upload(principal.id(), file);
	}

	@DeleteMapping("/me/avatar")
	void remove(@AuthenticationPrincipal UserPrincipal principal) {
		avatars.remove(principal.id());
	}

	@GetMapping("/avatars/{userId}")
	ResponseEntity<byte[]> get(@PathVariable long userId) {
		AvatarService.AvatarContent avatar = avatars.get(userId);
		return ResponseEntity.ok()
				.contentType(MediaType.parseMediaType(avatar.contentType()))
				.cacheControl(CacheControl.noCache())
				.body(avatar.data());
	}
}
