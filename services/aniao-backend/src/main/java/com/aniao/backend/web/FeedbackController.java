package com.aniao.backend.web;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.feedback.FeedbackService;
import com.aniao.backend.user.UserRepository;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.time.Duration;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@RestController
@RequestMapping("/api/feedback")
public class FeedbackController {
	private static final Logger logger = LoggerFactory.getLogger(FeedbackController.class);
	private final FeedbackService feedback;
	private final UserRepository users;

	public FeedbackController(FeedbackService feedback, UserRepository users) {
		this.feedback = feedback;
		this.users = users;
	}

	@PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
	FeedbackService.FeedbackView create(
			@AuthenticationPrincipal UserPrincipal principal,
			@RequestParam("content") String content,
			@RequestPart(value = "images", required = false) List<MultipartFile> images) {
		/*
		 * ========================================================================
		 * 步骤1：接收匿名反馈与附件
		 * ========================================================================
		 * 数据源：可选账号身份和 multipart 表单。
		 * 操作：1) 无账号时不查用户；2) 复用内容与图片校验。
		 */
		logger.info("开始接收反馈");
		try {
			// 1.1 匿名提交不生成账号，也不借用管理员身份。
			var user = principal == null ? null : users.findById(principal.id()).orElseThrow();
			return feedback.create(user, content, images);
		} finally {
			logger.info("反馈接收结束");
		}
	}

	@GetMapping("/mine")
	List<FeedbackService.FeedbackView> mine(@AuthenticationPrincipal UserPrincipal principal) {
		return feedback.mine(principal.id());
	}

	@GetMapping("/images/{id}")
	ResponseEntity<byte[]> image(@PathVariable String id) {
		FeedbackService.ImageContent image = feedback.image(id);
		return ResponseEntity.ok()
				.contentType(MediaType.parseMediaType(image.contentType()))
				.cacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePublic().immutable())
				.header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + image.filename().replace("\"", "") + "\"")
				.body(image.data());
	}
}
