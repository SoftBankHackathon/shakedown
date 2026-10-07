package com.kty.board.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class CommentRequest {
    private Long postId;
    private Long memberId;

    @NotBlank(message = "댓글 내용은 비어있을 수 없습니다.")
    private String content;
}