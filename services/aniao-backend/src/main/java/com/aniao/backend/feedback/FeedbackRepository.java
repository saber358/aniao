package com.aniao.backend.feedback;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FeedbackRepository extends JpaRepository<Feedback, Long> {
	List<Feedback> findByUserIdOrderByCreatedAtDesc(long userId);

	Page<Feedback> findAllByOrderByCreatedAtDesc(Pageable pageable);
}
