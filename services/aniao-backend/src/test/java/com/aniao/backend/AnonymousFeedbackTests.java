package com.aniao.backend;

import com.aniao.backend.feedback.FeedbackSchemaMigration;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:aniao-anonymous;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AnonymousFeedbackTests {
	private static final Logger logger = LoggerFactory.getLogger(AnonymousFeedbackTests.class);
	@Autowired private MockMvc mvc;
	@Autowired private ObjectMapper objectMapper;

	/*
	 * ========================================================================
	 * 步骤1：回归匿名提交、图片与管理权限
	 * ========================================================================
	 * 数据源：真实 Spring Security、H2 和 multipart 请求。
	 * 操作：1) 无凭据完成提交；2) 管理员可处理，匿名不能读取管理列表。
	 */
	@Test
	void anonymousSubmissionAndAdminReview() throws Exception {
		logger.info("开始验证匿名反馈完整链路");
		try {
			// 1.1 不发送 Authorization，仍可保存正文与图片。
			byte[] png = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
			String response = mvc.perform(multipart("/api/feedback")
					.file(new MockMultipartFile("images", "截图.png", "image/png", png))
					.param("content", "无需登录的反馈"))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.displayName").value("匿名用户"))
					.andExpect(jsonPath("$.username").value(""))
					.andExpect(jsonPath("$.content").value("无需登录的反馈"))
					.andExpect(jsonPath("$.images.length()").value(1))
					.andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
			var feedback = objectMapper.readTree(response);
			mvc.perform(get(feedback.get("images").get(0).get("url").asText()))
					.andExpect(status().isOk());
			mvc.perform(get("/api/feedback/mine")).andExpect(status().isUnauthorized());
			mvc.perform(get("/api/admin/feedback")).andExpect(status().isUnauthorized());
			mvc.perform(patch("/api/admin/feedback/" + feedback.get("id").asLong()))
					.andExpect(status().isUnauthorized());

			// 1.2 复用后台管理员登录，匿名投稿可在原管理列表查看与处理。
			var admin = objectMapper.readTree(mvc.perform(post("/api/auth/login")
					.contentType("application/json")
					.content("{\"username\":\"admin\",\"password\":\"Admin12345!\"}"))
					.andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
			String token = admin.get("token").asText();
			mvc.perform(get("/api/admin/feedback").header("Authorization", "Bearer " + token))
					.andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1))
					.andExpect(jsonPath("$.items[0].displayName").value("匿名用户"));
			mvc.perform(patch("/api/admin/feedback/" + feedback.get("id").asLong())
					.header("Authorization", "Bearer " + token).contentType("application/json")
					.content("{\"status\":\"RESOLVED\"}"))
					.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("RESOLVED"));
			mvc.perform(multipart("/api/feedback").param("content", " "))
					.andExpect(status().isBadRequest());
		} finally {
			logger.info("匿名反馈完整链路验证结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：回归旧 H2 约束迁移
	 * ========================================================================
	 * 数据源：独立 H2 中原有非空 user_id 列与历史行。
	 * 操作：1) 两次迁移都成功；2) 保留历史账号关系并支持新匿名行。
	 */
	@Test
	void migratesExistingNonNullableUserColumnIdempotently() throws Exception {
		logger.info("开始验证旧反馈数据库迁移");
		try {
			// 2.1 不依赖 Hibernate 新建表，明确模拟发布前的约束。
			var source = new DriverManagerDataSource("jdbc:h2:mem:feedback-migration;DB_CLOSE_DELAY=-1", "sa", "");
			try (var connection = source.getConnection(); var statement = connection.createStatement()) {
				statement.execute("CREATE TABLE feedback (id BIGINT, user_id BIGINT NOT NULL)");
				statement.execute("INSERT INTO feedback VALUES (1, 42)");
				var migration = new FeedbackSchemaMigration(source);
				migration.run(new DefaultApplicationArguments());
				migration.run(new DefaultApplicationArguments());
				statement.execute("INSERT INTO feedback VALUES (2, NULL)");
				try (var rows = statement.executeQuery("SELECT user_id FROM feedback WHERE id=1")) {
					rows.next(); assertEquals(42, rows.getLong(1));
				}
			}
		} finally {
			logger.info("旧反馈数据库迁移验证结束");
		}
	}
}
