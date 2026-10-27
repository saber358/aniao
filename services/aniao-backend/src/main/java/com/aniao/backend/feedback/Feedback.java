package com.aniao.backend.feedback;

import com.aniao.backend.user.AppUser;
import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "feedback", indexes = {
		@Index(name = "idx_feedback_user_time", columnList = "user_id,created_at"),
		@Index(name = "idx_feedback_status", columnList = "status")
})
public class Feedback {
	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	// 匿名反馈不关联账号，已有反馈继续保留原用户关系。
	@ManyToOne(fetch = FetchType.LAZY)
	@JoinColumn(name = "user_id")
	private AppUser user;

	@Column(nullable = false, length = 5000)
	private String content;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 20)
	private FeedbackStatus status = FeedbackStatus.OPEN;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt = Instant.now();

	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt = Instant.now();

	@OneToMany(mappedBy = "feedback", cascade = CascadeType.ALL, orphanRemoval = true)
	private List<FeedbackImage> images = new ArrayList<>();

	protected Feedback() {
	}

	public Feedback(AppUser user, String content) {
		this.user = user;
		this.content = content;
		this.createdAt = Instant.now();
		this.updatedAt = this.createdAt;
	}

	public void addImage(FeedbackImage image) {
		images.add(image);
		image.setFeedback(this);
	}

	public Long getId() {
		return id;
	}

	public AppUser getUser() {
		return user;
	}

	public String getContent() {
		return content;
	}

	public FeedbackStatus getStatus() {
		return status;
	}

	public void setStatus(FeedbackStatus status) {
		this.status = status;
		this.updatedAt = Instant.now();
	}

	public Instant getCreatedAt() {
		return createdAt;
	}

	public Instant getUpdatedAt() {
		return updatedAt;
	}

	public List<FeedbackImage> getImages() {
		return images;
	}
}
