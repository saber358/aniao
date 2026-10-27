package com.aniao.backend.feedback;

import com.aniao.backend.common.ApiException;
import com.aniao.backend.common.PageView;
import com.aniao.backend.user.AppUser;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Service
public class FeedbackService {
	private static final Logger logger = LoggerFactory.getLogger(FeedbackService.class);
	private static final int MAX_IMAGES = 4;
	private static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;
	private static final Set<String> ALLOWED_TYPES = Set.of("image/png", "image/jpeg", "image/webp", "image/gif");

	private final FeedbackRepository feedback;
	private final FeedbackImageRepository images;

	public FeedbackService(FeedbackRepository feedback, FeedbackImageRepository images) {
		this.feedback = feedback;
		this.images = images;
	}

	@Transactional
	public FeedbackView create(AppUser user, String contentInput, List<MultipartFile> files) {
		String content = contentInput == null ? "" : contentInput.trim();
		if (content.isEmpty() || content.length() > 5000) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_content", "反馈内容需为 1-5000 字");
		}
		List<MultipartFile> uploads = files == null ? List.of() : files.stream().filter(file -> !file.isEmpty()).toList();
		if (uploads.size() > MAX_IMAGES) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "too_many_images", "最多上传 4 张图片");
		}
		Feedback entity = new Feedback(user, content);
		for (MultipartFile file : uploads) {
			validateImage(file);
			try {
				entity.addImage(new FeedbackImage(
						UUID.randomUUID().toString(),
						file.getBytes(),
						file.getContentType(),
						safeName(file.getOriginalFilename())));
			} catch (IOException exception) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "image_read_failed", "图片读取失败");
			}
		}
		feedback.save(entity);
		return FeedbackView.from(entity);
	}

	@Transactional(readOnly = true)
	public List<FeedbackView> mine(long userId) {
		return feedback.findByUserIdOrderByCreatedAtDesc(userId).stream()
				.limit(100)
				.map(FeedbackView::from)
				.toList();
	}

	@Transactional(readOnly = true)
	public PageView<FeedbackView> all(int page, int size) {
		int safePage = Math.max(0, page);
		int safeSize = Math.min(100, Math.max(1, size));
		var result = feedback.findAllByOrderByCreatedAtDesc(
				org.springframework.data.domain.PageRequest.of(safePage, safeSize));
		return new PageView<>(
				result.getContent().stream().map(FeedbackView::from).toList(),
				result.getTotalElements(),
				safePage,
				safeSize);
	}

	@Transactional
	public FeedbackView updateStatus(long id, FeedbackStatus status) {
		Feedback entity = feedback.findById(id)
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "not_found", "反馈不存在"));
		entity.setStatus(status);
		feedback.save(entity);
		return FeedbackView.from(entity);
	}

	@Transactional(readOnly = true)
	public ImageContent image(String id) {
		FeedbackImage image = images.findById(id)
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "not_found", "图片不存在"));
		return new ImageContent(image.getData(), image.getContentType(), image.getOriginalName());
	}

	private void validateImage(MultipartFile file) {
		String contentType = file.getContentType() == null ? "" : file.getContentType().toLowerCase(Locale.ROOT);
		if (!ALLOWED_TYPES.contains(contentType)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_image_type", "仅支持 PNG、JPEG、WebP 或 GIF 图片");
		}
		if (file.getSize() > MAX_IMAGE_BYTES) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "image_too_large", "单张图片不能超过 5MB");
		}
	}

	private String safeName(String name) {
		if (name == null || name.isBlank()) return "image";
		String value = name.replace('\\', '/');
		value = value.substring(value.lastIndexOf('/') + 1).trim();
		return value.isEmpty() ? "image" : value.substring(0, Math.min(200, value.length()));
	}

	public record FeedbackView(
			long id,
			String content,
			FeedbackStatus status,
			Instant createdAt,
			Instant updatedAt,
			String username,
			String displayName,
			List<ImageView> images) {
		private static FeedbackView from(Feedback entity) {
			/*
			 * ========================================================================
			 * 步骤1：生成含匿名署名的反馈视图
			 * ========================================================================
			 * 数据源：已保存反馈及可空用户关系。
			 * 操作：1) 匿名记录使用固定署名；2) 保留图片和状态字段。
			 */
			logger.info("开始生成反馈视图");
			try {
			// 1.1 空关联只影响展示，不创建占位用户。
			AppUser user = entity.getUser();
			return new FeedbackView(
					entity.getId(),
					entity.getContent(),
					entity.getStatus(),
					entity.getCreatedAt(),
					entity.getUpdatedAt(),
					user == null ? "" : user.getUsername(),
					user == null ? "匿名用户" : user.getDisplayName(),
					entity.getImages().stream().map(ImageView::from).toList());
			} finally {
				logger.info("反馈视图生成结束");
			}
		}
	}

	public record ImageView(String id, String name, String contentType, long size, String url) {
		private static ImageView from(FeedbackImage image) {
			return new ImageView(
					image.getId(),
					image.getOriginalName(),
					image.getContentType(),
					image.getSize(),
					"/api/feedback/images/" + image.getId());
		}
	}

	public record ImageContent(byte[] data, String contentType, String filename) {
	}
}
