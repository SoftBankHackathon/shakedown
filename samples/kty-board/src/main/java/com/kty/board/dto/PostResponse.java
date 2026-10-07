package com.kty.board.dto;

import com.kty.board.domain.Post;
import lombok.Getter;

import java.util.List;
import java.util.stream.Collectors;

@Getter
public class PostResponse {
    private Long id;
    private String title;
    private String content;
    private String nickname;
    private int viewCount;
    private List<CommentResponse> comments; // 이 필드가 detail.html의 th:each와 연결됨

    // 생성자를 하나로 통합합니다.
    // 목록 조회 시에는 comments가 자연스럽게 비어있게 되고, 상세 조회 시에는 담기게 됩니다.
    public PostResponse(Post post) {
        this.id = post.getId();
        this.title = post.getTitle();
        this.content = post.getContent();
        this.nickname = post.getMember().getNickname();
        this.viewCount = post.getViewCount();

        // Post 엔티티 안에 comments 리스트가 있다면 DTO로 변환해서 담아줍니다.
        if (post.getComments() != null) {
            this.comments = post.getComments().stream()
                    .map(CommentResponse::new)
                    .collect(Collectors.toList());
        }
    }
}