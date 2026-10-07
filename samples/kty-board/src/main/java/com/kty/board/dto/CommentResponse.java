package com.kty.board.dto;

import com.kty.board.domain.Comment;
import lombok.Getter;

@Getter
public class CommentResponse {
    private Long id;
    private String content;
    private String nickname;

    public CommentResponse(Comment comment) {
        this.id = comment.getId();
        this.content = comment.getContent();
        this.nickname = comment.getMember().getNickname();
    }
}