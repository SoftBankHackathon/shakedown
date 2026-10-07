package com.kty.board.repository;

import com.kty.board.domain.Post;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List; // 🔥 바로 이 줄입니다! 이 줄이 없거나 다른 List였을 거예요.

public interface PostRepository extends JpaRepository<Post, Long> {

    // Id 내림차순 정렬 (최신순)
    List<Post> findAllByOrderByIdDesc();
}