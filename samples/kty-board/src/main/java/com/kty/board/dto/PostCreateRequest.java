package com.kty.board.dto;

import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class PostCreateRequest {
    private Long memberId;
    private String title;
    private String content;
}