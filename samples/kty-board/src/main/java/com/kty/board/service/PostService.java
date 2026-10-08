package com.kty.board.service;

import com.kty.board.domain.Member;
import com.kty.board.domain.Post;
import com.kty.board.repository.MemberRepository;
import com.kty.board.repository.PostRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List; // 👈 1. util 패키지 확인

@Service
@Transactional(readOnly = true)
@RequiredArgsConstructor
public class PostService {

    private final PostRepository postRepository;
    private final MemberRepository memberRepository;

    public List<Post> findPosts() {
        // 2. 이제 Incompatible types 에러가 사라집니다.
        return postRepository.findAllByOrderByIdDesc();
    }

    @Transactional
    public Long write(Long memberId, String title, String content) {
        Member member = memberRepository.findById(memberId)
                .orElseThrow(() -> new IllegalArgumentException("회원 없음"));

        Post post = Post.builder()
                .title(title)
                .content(content)
                .member(member)
                .build();

        return postRepository.save(post).getId();
    }

    @Transactional
    public Post findOne(Long postId) {
        Post post = postRepository.findById(postId).orElseThrow();
        post.addViewCount();
        return post;
    }

    public Post getPost(Long postId) {
        return postRepository.findById(postId).orElseThrow();
    }
    // PostService.java 에 추가하세요

    /**
     * 게시글 수정 로직
     */
    @Transactional
    public void updatePost(Long postId, String title, String content) {
        // 1. 수정할 게시글을 창고(DB)에서 찾아옵니다.
        Post post = postRepository.findById(postId)
                .orElseThrow(() -> new IllegalArgumentException("게시글이 존재하지 않습니다."));

        // 2. 찾아온 게시글 객체의 내용을 새로운 제목과 내용으로 바꿉니다. (Dirty Checking 이용)
        post.update(title, content);
    }

    /**
     * 게시글 삭제 로직
     */
    @Transactional
    public void deletePost(Long postId) {
        // 1. 삭제할 게시글이 있는지 확인하고 삭제합니다.
        postRepository.deleteById(postId);
    }
}