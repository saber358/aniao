package com.aniao.backend.usage;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;

public interface UsageRepository extends JpaRepository<UsageRecord, Long> {
	List<UsageRecord> findByUserIdAndOccurredAtBetween(long userId, Instant from, Instant to);

	Page<UsageRecord> findByUserIdAndOccurredAtBetween(long userId, Instant from, Instant to, Pageable pageable);

	List<UsageRecord> findByOccurredAtBetween(Instant from, Instant to);

	List<UsageRecord> findByUserId(long userId);
}
