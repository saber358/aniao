package com.aniao.backend.auth;

import com.aniao.backend.common.ApiExceptionHandler.ApiError;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {
	private static final Logger logger = LoggerFactory.getLogger(SecurityConfig.class);
	@Bean
	SecurityFilterChain securityFilterChain(
			HttpSecurity http,
			JwtAuthenticationFilter jwtFilter,
			ObjectMapper objectMapper) throws Exception {
		/*
		 * ========================================================================
		 * 步骤1：仅放开匿名反馈提交
		 * ========================================================================
		 * 数据源：HTTP 方法与资源路径。
		 * 操作：1) POST 反馈无需账号；2) 历史查询和管理接口继续鉴权。
		 */
		logger.info("开始配置匿名反馈权限");
		// 1.1 精确匹配提交入口，不开放个人历史或管理接口。
		http
				.csrf(csrf -> csrf.disable())
				.cors(Customizer.withDefaults())
				.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
				.formLogin(form -> form.disable())
				.httpBasic(basic -> basic.disable())
				.authorizeHttpRequests(auth -> auth
						.requestMatchers(HttpMethod.POST, "/api/feedback").permitAll()
						.requestMatchers("/api/auth/**", "/api/health", "/api/feedback/images/**", "/api/avatars/**").permitAll()
						.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
						.requestMatchers("/api/admin/**").hasRole("ADMIN")
						.anyRequest().authenticated())
				.exceptionHandling(exceptions -> exceptions
						.authenticationEntryPoint((request, response, exception) -> writeError(
								response,
								objectMapper,
								HttpServletResponse.SC_UNAUTHORIZED,
								"unauthorized",
								"请先登录"))
						.accessDeniedHandler((request, response, exception) -> writeError(
								response,
								objectMapper,
								HttpServletResponse.SC_FORBIDDEN,
								"forbidden",
								"没有权限执行该操作")))
				.addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
		SecurityFilterChain chain = http.build();
		logger.info("匿名反馈权限配置完成");
		return chain;
	}

	@Bean
	CorsConfigurationSource corsConfigurationSource() {
		CorsConfiguration configuration = new CorsConfiguration();
		configuration.setAllowedOriginPatterns(List.of("*"));
		configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
		configuration.setAllowedHeaders(List.of("Authorization", "Content-Type", "Accept", "Origin"));
		configuration.setExposedHeaders(List.of("Location"));
		configuration.setMaxAge(3600L);
		UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
		source.registerCorsConfiguration("/**", configuration);
		return source;
	}

	private static void writeError(HttpServletResponse response, ObjectMapper mapper, int status, String code, String message)
			throws java.io.IOException {
		response.setStatus(status);
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		response.setCharacterEncoding("UTF-8");
		mapper.writeValue(response.getWriter(), new ApiError(code, message, Instant.now()));
	}
}
