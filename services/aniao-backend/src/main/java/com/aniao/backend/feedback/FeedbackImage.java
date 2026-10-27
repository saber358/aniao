package com.aniao.backend.feedback;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Lob;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

@Entity
@Table(name = "feedback_images")
public class FeedbackImage {
	@Id
	@Column(length = 36)
	private String id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "feedback_id", nullable = false)
	private Feedback feedback;

	@Lob
	@Column(nullable = false)
	private byte[] data;

	@Column(name = "content_type", nullable = false, length = 100)
	private String contentType;

	@Column(name = "original_name", nullable = false, length = 200)
	private String originalName;

	@Column(name = "size_bytes", nullable = false)
	private long size;

	protected FeedbackImage() {
	}

	public FeedbackImage(String id, byte[] data, String contentType, String originalName) {
		this.id = id;
		this.data = data;
		this.contentType = contentType;
		this.originalName = originalName;
		this.size = data.length;
	}

	public String getId() {
		return id;
	}

	public Feedback getFeedback() {
		return feedback;
	}

	public void setFeedback(Feedback feedback) {
		this.feedback = feedback;
	}

	public byte[] getData() {
		return data;
	}

	public String getContentType() {
		return contentType;
	}

	public String getOriginalName() {
		return originalName;
	}

	public long getSize() {
		return size;
	}
}
