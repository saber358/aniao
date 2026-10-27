package com.aniao.backend.usage;

import com.aniao.backend.user.AppUser;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "usage_records", indexes = {
		@Index(name = "idx_usage_user_time", columnList = "user_id,occurred_at"),
		@Index(name = "idx_usage_model", columnList = "model")
})
public class UsageRecord {
	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "user_id", nullable = false)
	private AppUser user;

	@Column(nullable = false, length = 64)
	private String provider;

	@Column(nullable = false, length = 100)
	private String model;

	@Column(name = "prompt_tokens", nullable = false)
	private long promptTokens;

	@Column(name = "completion_tokens", nullable = false)
	private long completionTokens;

	@Column(name = "total_tokens", nullable = false)
	private long totalTokens;

	@Column(name = "session_id", length = 200)
	private String sessionId;

	@Column(name = "occurred_at", nullable = false)
	private Instant occurredAt;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt = Instant.now();

	protected UsageRecord() {
	}

	public UsageRecord(AppUser user, String provider, String model, long promptTokens, long completionTokens,
			String sessionId, Instant occurredAt) {
		this.user = user;
		this.provider = provider;
		this.model = model;
		this.promptTokens = promptTokens;
		this.completionTokens = completionTokens;
		this.totalTokens = promptTokens + completionTokens;
		this.sessionId = sessionId;
		this.occurredAt = occurredAt;
		this.createdAt = Instant.now();
	}

	public Long getId() {
		return id;
	}

	public AppUser getUser() {
		return user;
	}

	public String getProvider() {
		return provider;
	}

	public String getModel() {
		return model;
	}

	public long getPromptTokens() {
		return promptTokens;
	}

	public long getCompletionTokens() {
		return completionTokens;
	}

	public long getTotalTokens() {
		return totalTokens;
	}

	public String getSessionId() {
		return sessionId;
	}

	public Instant getOccurredAt() {
		return occurredAt;
	}

	public Instant getCreatedAt() {
		return createdAt;
	}
}
