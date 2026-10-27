package com.aniao.backend.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Lob;
import jakarta.persistence.MapsId;
import jakarta.persistence.OneToOne;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "user_avatars")
public class UserAvatar {
	@Id
	@Column(name = "user_id")
	private Long userId;

	@MapsId
	@OneToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "user_id")
	private AppUser user;

	@Lob
	@Column(nullable = false)
	private byte[] data;

	@Column(name = "content_type", nullable = false, length = 100)
	private String contentType;

	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt = Instant.now();

	protected UserAvatar() {
	}

	public UserAvatar(AppUser user, byte[] data, String contentType) {
		this.user = user;
		this.userId = user.getId();
		this.data = data;
		this.contentType = contentType;
		this.updatedAt = Instant.now();
	}

	public Long getUserId() {
		return userId;
	}

	public AppUser getUser() {
		return user;
	}

	public byte[] getData() {
		return data;
	}

	public String getContentType() {
		return contentType;
	}

	public Instant getUpdatedAt() {
		return updatedAt;
	}

	public void replace(byte[] data, String contentType) {
		this.data = data;
		this.contentType = contentType;
		this.updatedAt = Instant.now();
	}
}
