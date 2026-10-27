package com.aniao.backend.auth;

import com.aniao.backend.user.AppUser;
import com.aniao.backend.user.UserRepository;
import com.aniao.backend.user.UserStatus;
import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {
	private final JwtService jwt;
	private final UserRepository users;

	public JwtAuthenticationFilter(JwtService jwt, UserRepository users) {
		this.jwt = jwt;
		this.users = users;
	}

	@Override
	protected void doFilterInternal(
			HttpServletRequest request,
			HttpServletResponse response,
			FilterChain filterChain) throws ServletException, IOException {
		String authorization = request.getHeader("Authorization");
		if (authorization != null && authorization.startsWith("Bearer ")) {
			String token = authorization.substring(7).trim();
			Claims claims = jwt.parse(token);
			if (claims != null) {
				try {
					long id = Long.parseLong(claims.getSubject());
					AppUser user = users.findById(id).orElse(null);
					if (user != null && user.getStatus() == UserStatus.ACTIVE) {
						UserPrincipal principal = new UserPrincipal(user.getId(), user.getUsername(), user.getRole());
						var authentication = new UsernamePasswordAuthenticationToken(
								principal,
								null,
								List.of(new SimpleGrantedAuthority("ROLE_" + user.getRole().name())));
						SecurityContextHolder.getContext().setAuthentication(authentication);
					}
				} catch (NumberFormatException ignored) {
					SecurityContextHolder.clearContext();
				}
			}
		}
		filterChain.doFilter(request, response);
	}
}
