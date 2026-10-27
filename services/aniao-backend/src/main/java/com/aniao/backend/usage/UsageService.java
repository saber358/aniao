package com.aniao.backend.usage;

import com.aniao.backend.common.ApiException;
import com.aniao.backend.common.PageView;
import com.aniao.backend.user.AppUser;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class UsageService {
	private final UsageRepository usage;
	private final ZoneId zone;

	public UsageService(UsageRepository usage, @Value("${app.time-zone:Asia/Shanghai}") String zone) {
		this.usage = usage;
		this.zone = ZoneId.of(zone);
	}

	@Transactional
	public UsageView record(AppUser user, UsageRequest request) {
		Instant occurredAt = request.occurredAt() == null ? Instant.now() : request.occurredAt();
		if (occurredAt.isAfter(Instant.now().plus(1, ChronoUnit.DAYS))) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_time", "用量时间不能晚于当前时间太多");
		}
		UsageRecord record = usage.save(new UsageRecord(
				user,
				request.provider().trim(),
				request.model().trim(),
				request.promptTokens(),
				request.completionTokens(),
				request.sessionId(),
				occurredAt));
		return UsageView.from(record);
	}

	@Transactional(readOnly = true)
	public UsageSummary summary(long userId, Instant fromInput, Instant toInput) {
		Range range = range(fromInput, toInput);
		return summarize(usage.findByUserIdAndOccurredAtBetween(userId, range.from(), range.to()), range);
	}

	@Transactional(readOnly = true)
	public PageView<UsageView> records(long userId, Instant fromInput, Instant toInput, int page, int size) {
		Range range = range(fromInput, toInput);
		int safePage = Math.max(0, page);
		int safeSize = Math.min(100, Math.max(1, size));
		Page<UsageRecord> result = usage.findByUserIdAndOccurredAtBetween(
				userId,
				range.from(),
				range.to(),
				PageRequest.of(safePage, safeSize, Sort.by(Sort.Direction.DESC, "occurredAt")));
		return new PageView<>(
				result.getContent().stream().map(UsageView::from).toList(),
				result.getTotalElements(),
				safePage,
				safeSize);
	}

	@Transactional(readOnly = true)
	public AdminUsageSummary adminSummary(Long userId, Instant fromInput, Instant toInput) {
		Range range = range(fromInput, toInput);
		List<UsageRecord> records = userId == null
				? usage.findByOccurredAtBetween(range.from(), range.to())
				: usage.findByUserIdAndOccurredAtBetween(userId, range.from(), range.to());
		UsageSummary summary = summarize(records, range);
		Map<Long, UserAggregate> byUser = new LinkedHashMap<>();
		for (UsageRecord record : records) {
			AppUser user = record.getUser();
			UserAggregate aggregate = byUser.computeIfAbsent(user.getId(), ignored -> new UserAggregate(user));
			aggregate.tokens += record.getTotalTokens();
			aggregate.calls++;
		}
		List<UserUsage> userRows = byUser.values().stream()
				.map(value -> new UserUsage(
						value.user.getId(),
						value.user.getUsername(),
						value.user.getDisplayName(),
						value.tokens,
						value.calls))
				.sorted(Comparator.comparingLong(UserUsage::tokens).reversed())
				.toList();
		return new AdminUsageSummary(
				summary.from(),
				summary.to(),
				summary.totalTokens(),
				summary.promptTokens(),
				summary.completionTokens(),
				summary.calls(),
				summary.byModel(),
				summary.byDay(),
				userRows);
	}

	private UsageSummary summarize(List<UsageRecord> records, Range range) {
		long prompt = 0;
		long completion = 0;
		Map<String, Long> modelTokens = new LinkedHashMap<>();
		Map<String, Long> modelCalls = new LinkedHashMap<>();
		Map<LocalDate, Long> dayTokens = new LinkedHashMap<>();
		Map<LocalDate, Long> dayCalls = new LinkedHashMap<>();
		for (UsageRecord record : records) {
			prompt += record.getPromptTokens();
			completion += record.getCompletionTokens();
			modelTokens.merge(record.getModel(), record.getTotalTokens(), Long::sum);
			modelCalls.merge(record.getModel(), 1L, Long::sum);
			LocalDate day = record.getOccurredAt().atZone(zone).toLocalDate();
			dayTokens.merge(day, record.getTotalTokens(), Long::sum);
			dayCalls.merge(day, 1L, Long::sum);
		}
		List<ModelUsage> byModel = modelTokens.entrySet().stream()
				.map(entry -> new ModelUsage(entry.getKey(), entry.getValue(), modelCalls.getOrDefault(entry.getKey(), 0L)))
				.sorted(Comparator.comparingLong(ModelUsage::tokens).reversed())
				.toList();
		List<DayUsage> byDay = dayTokens.entrySet().stream()
				.sorted(Map.Entry.comparingByKey())
				.map(entry -> new DayUsage(entry.getKey().toString(), entry.getValue(), dayCalls.getOrDefault(entry.getKey(), 0L)))
				.toList();
		return new UsageSummary(
				range.from(),
				range.to(),
				prompt + completion,
				prompt,
				completion,
				(long) records.size(),
				byModel,
				byDay);
	}

	private Range range(Instant fromInput, Instant toInput) {
		Instant to = toInput == null ? Instant.now() : toInput;
		Instant from = fromInput == null ? to.minus(30, ChronoUnit.DAYS) : fromInput;
		if (from.isAfter(to)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_range", "开始时间不能晚于结束时间");
		}
		if (from.isBefore(to.minus(370, ChronoUnit.DAYS))) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "range_too_large", "统计范围最多 370 天");
		}
		return new Range(from, to);
	}

	private record Range(Instant from, Instant to) {
	}

	private static final class UserAggregate {
		private final AppUser user;
		private long tokens;
		private long calls;

		private UserAggregate(AppUser user) {
			this.user = user;
		}
	}

	public record UsageRequest(
			@jakarta.validation.constraints.NotBlank
			@jakarta.validation.constraints.Size(max = 64) String provider,
			@jakarta.validation.constraints.NotBlank
			@jakarta.validation.constraints.Size(max = 100) String model,
			@jakarta.validation.constraints.Min(0)
			@jakarta.validation.constraints.Max(100_000_000) long promptTokens,
			@jakarta.validation.constraints.Min(0)
			@jakarta.validation.constraints.Max(100_000_000) long completionTokens,
			@jakarta.validation.constraints.Size(max = 200) String sessionId,
			Instant occurredAt) {
	}

	public record UsageView(
			long id,
			String provider,
			String model,
			long promptTokens,
			long completionTokens,
			long totalTokens,
			String sessionId,
			Instant occurredAt) {
		private static UsageView from(UsageRecord record) {
			return new UsageView(
					record.getId(),
					record.getProvider(),
					record.getModel(),
					record.getPromptTokens(),
					record.getCompletionTokens(),
					record.getTotalTokens(),
					record.getSessionId(),
					record.getOccurredAt());
		}
	}

	public record ModelUsage(String model, long tokens, long calls) {
	}

	public record DayUsage(String date, long tokens, long calls) {
	}

	public record UsageSummary(
			Instant from,
			Instant to,
			long totalTokens,
			long promptTokens,
			long completionTokens,
			long calls,
			List<ModelUsage> byModel,
			List<DayUsage> byDay) {
	}

	public record UserUsage(long userId, String username, String displayName, long tokens, long calls) {
	}

	public record AdminUsageSummary(
			Instant from,
			Instant to,
			long totalTokens,
			long promptTokens,
			long completionTokens,
			long calls,
			List<ModelUsage> byModel,
			List<DayUsage> byDay,
			List<UserUsage> byUser) {
	}
}
