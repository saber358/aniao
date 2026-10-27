package com.aniao.backend;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AniaoBackendApplicationTests {
	private static final byte[] PNG = Base64.getDecoder().decode(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");

	@Autowired
	private MockMvc mvc;

	@Autowired
	private ObjectMapper objectMapper;

	@Test
	void authUsageFeedbackAndAdminStatusFlow() throws Exception {
		String username = "user" + System.nanoTime();
		String register = mvc.perform(post("/api/auth/register")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"username":"%s","password":"UserPass123!","displayName":"测试用户"}
								""".formatted(username)))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.user.username").value(username))
				.andReturn().getResponse().getContentAsString();
		String token = objectMapper.readTree(register).get("token").asText();

		mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.role").value("USER"))
				.andExpect(jsonPath("$.avatarUrl").isNotEmpty());

		mvc.perform(get("/api/avatars/" + objectMapper.readTree(register).get("user").get("id").asLong()))
				.andExpect(status().isOk())
				.andExpect(result -> org.junit.jupiter.api.Assertions.assertTrue(
						result.getResponse().getContentAsString().contains("<svg")));

		var avatar = new MockMultipartFile("file", "avatar.png", "image/png", PNG);
		mvc.perform(multipart("/api/me/avatar")
						.file(avatar)
						.header("Authorization", "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.avatarUrl").isNotEmpty());
		mvc.perform(get("/api/avatars/" + objectMapper.readTree(register).get("user").get("id").asLong()))
				.andExpect(status().isOk())
				.andExpect(result -> org.junit.jupiter.api.Assertions.assertArrayEquals(
						PNG, result.getResponse().getContentAsByteArray()));

		mvc.perform(post("/api/usage")
						.header("Authorization", "Bearer " + token)
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"provider":"aniao","model":"grok-4.7","promptTokens":120,"completionTokens":80,"sessionId":"s-1"}
								"""))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.totalTokens").value(200));

		mvc.perform(get("/api/usage/summary").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.totalTokens").value(200))
				.andExpect(jsonPath("$.byModel[0].model").value("grok-4.7"));

		var image = new MockMultipartFile("images", "pixel.png", "image/png", PNG);
		String feedback = mvc.perform(multipart("/api/feedback")
						.file(image)
						.param("content", "界面运行正常")
						.header("Authorization", "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.content").value("界面运行正常"))
				.andExpect(jsonPath("$.images.length()").value(1))
				.andReturn().getResponse().getContentAsString();
		String imageId = objectMapper.readTree(feedback).get("images").get(0).get("id").asText();
		mvc.perform(get("/api/feedback/images/" + imageId))
				.andExpect(status().isOk())
				.andExpect(result -> org.junit.jupiter.api.Assertions.assertArrayEquals(
						PNG, result.getResponse().getContentAsByteArray()));

		JsonNode admin = objectMapper.readTree(mvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{"username":"admin","password":"Admin12345!"}
								"""))
				.andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
		String adminToken = admin.get("token").asText();
		mvc.perform(get("/api/admin/feedback").header("Authorization", "Bearer " + adminToken))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.total").value(1));
		mvc.perform(get("/api/admin/usage/summary").header("Authorization", "Bearer " + adminToken))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.totalTokens").value(200));

		String users = mvc.perform(get("/api/admin/users").header("Authorization", "Bearer " + adminToken))
				.andReturn().getResponse().getContentAsString();
		long userId = 0;
		for (JsonNode user : objectMapper.readTree(users)) {
			if (username.equals(user.get("username").asText())) userId = user.get("id").asLong();
		}
		mvc.perform(patch("/api/admin/users/" + userId + "/status")
						.header("Authorization", "Bearer " + adminToken)
						.contentType(MediaType.APPLICATION_JSON)
						.content("{\"status\":\"DISABLED\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("DISABLED"));
		mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isUnauthorized());
	}
}
