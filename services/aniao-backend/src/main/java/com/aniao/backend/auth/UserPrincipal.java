package com.aniao.backend.auth;

import com.aniao.backend.user.Role;

public record UserPrincipal(long id, String username, Role role) {
}
