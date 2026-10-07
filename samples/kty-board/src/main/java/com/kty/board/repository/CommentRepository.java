package com.kty.board.repository;

import com.kty.board.domain.Comment;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface CommentRepository extends JpaRepository<Comment, Long> {
    // 특정 게시글에 달린 댓글들만 모아서 보고 싶을 때를 위해 추가
    List<Comment> findByPostId(Long postId);
}