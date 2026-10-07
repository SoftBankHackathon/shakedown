package com.kty.board.controller;

import com.kty.board.domain.Post;
import com.kty.board.dto.PostCreateRequest;
import com.kty.board.dto.PostResponse;
import com.kty.board.service.PostService;
import jakarta.servlet.http.HttpSession;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@Controller
@RequiredArgsConstructor
@RequestMapping("/api/posts")
public class PostController {

    private final PostService postService;

    /**
     * [화면용] 게시글 작성 처리
     */
    @PostMapping("/write")
    public String writePost(@RequestParam("title") String title,
                            @RequestParam("content") String content,
                            HttpSession session) {

        Object memberIdObj = session.getAttribute("loginMemberId");

        if (memberIdObj == null) {
            return "redirect:/";
        }

        Long loginMemberId = (Long) memberIdObj;
        postService.write(loginMemberId, title, content);

        return "redirect:/board";
    }

    /**
     * [API] 게시글 목록 조회
     */
    @GetMapping
    @ResponseBody
    public List<PostResponse> getPosts() {
        return postService.findPosts().stream()
                .map(PostResponse::new)
                .collect(Collectors.toList());
    }

    /**
     * [API] 게시글 상세 조회 (에러 지점 수정 완료)
     */
    @GetMapping("/{postId}")
    @ResponseBody
    public PostResponse getPostDetail(@PathVariable("postId") Long postId) {
        // PostService.findOne에서 이미 댓글(comments)이 포함된 Post를 가져옵니다.
        Post post = postService.findOne(postId);

        // 생성자가 하나로 통합되었으므로 post만 인자로 넘깁니다.
        return new PostResponse(post);
    }

    /**
     * [API] 게시글 수정
     */
    @PatchMapping("/{postId}")
    @ResponseBody
    public ResponseEntity<String> update(@PathVariable("postId") Long postId, @RequestBody PostCreateRequest request) {
        postService.updatePost(postId, request.getTitle(), request.getContent());
        return ResponseEntity.ok("게시글 수정 완료");
    }

    /**
     * [API] 게시글 삭제
     */
    @DeleteMapping("/{postId}")
    @ResponseBody
    public ResponseEntity<String> delete(@PathVariable("postId") Long postId) {
        postService.deletePost(postId);
        return ResponseEntity.ok("게시글 삭제 완료");
    }
    @PostMapping("/{postId}/delete")
    public String deletePost(@PathVariable("postId") Long postId, HttpSession session) {
        // 1. 보안 체크 (로그인 확인)
        if (session.getAttribute("loginMemberId") == null) return "redirect:/";

        // 2. 삭제 서비스 호출
        postService.deletePost(postId);

        // 3. 목록으로 리다이렉트
        return "redirect:/board";
    }
    /**
     * [화면용] 게시글 수정 처리 (POST 방식)
     */
    @PostMapping("/{postId}/edit")
    public String updatePost(@PathVariable("postId") Long postId,
                             @RequestParam("title") String title,
                             @RequestParam("content") String content,
                             HttpSession session) {

        // 1. 보안 체크
        if (session.getAttribute("loginMemberId") == null) return "redirect:/";

        // 2. 서비스 호출 (우리가 아까 만든 updatePost 메서드 실행)
        postService.updatePost(postId, title, content);

        // 3. 수정 완료 후 다시 상세 페이지로 이동
        return "redirect:/posts/" + postId + "/view";
    }
}