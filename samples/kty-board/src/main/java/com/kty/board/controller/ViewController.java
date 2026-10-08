package com.kty.board.controller;

import com.kty.board.domain.Post;
import com.kty.board.dto.PostResponse;
import com.kty.board.service.PostService;
import jakarta.servlet.http.HttpSession;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

import java.util.List;
import java.util.stream.Collectors;

@Controller
@RequiredArgsConstructor
public class ViewController {

    private final PostService postService;

    /**
     * 1. 첫 접속 시 로그인 페이지로 이동
     */
    @GetMapping("/")
    public String loginPage(HttpSession session) {
        // 이미 로그인된 사용자가 접속하면 바로 게시판으로 보냄
        if (session.getAttribute("loginMemberId") != null) {
            return "redirect:/board";
        }
        return "login";
    }

    /**
     * 2. 회원가입 페이지 이동
     */
    @GetMapping("/join")
    public String joinPage() {
        return "join";
    }

    /**
     * 3. 게시판 목록 페이지
     */
    @GetMapping("/board")
    public String boardPage(Model model, HttpSession session) {
        // 보안: 미로그인 사용자 차단
        if (session.getAttribute("loginMemberId") == null) {
            return "redirect:/";
        }

        // 서비스에서 가져온 Post 엔티티 리스트를 PostResponse DTO 리스트로 변환해서 전달
        List<PostResponse> posts = postService.findPosts().stream()
                .map(PostResponse::new)
                .collect(Collectors.toList());

        model.addAttribute("posts", posts);
        return "board";
    }

    /**
     * 4. 글쓰기 페이지 이동
     */
    @GetMapping("/write")
    public String writePage(HttpSession session) {
        if (session.getAttribute("loginMemberId") == null) {
            return "redirect:/";
        }
        return "write";
    }

    /**
     * [목록에서 클릭 시] 상세 페이지 (조회수 증가 O)
     */
    @GetMapping("/posts/{postId}")
    public String detailPage(@PathVariable("postId") Long postId, Model model, HttpSession session) {
        if (session.getAttribute("loginMemberId") == null) return "redirect:/";

        // findOne을 호출하여 조회수를 올립니다.
        model.addAttribute("post", new PostResponse(postService.findOne(postId)));
        return "detail";
    }
    /**
     * [댓글 등록 후 리다이렉트용] 상세 페이지 (조회수 증가 X)
     */
    @GetMapping("/posts/{postId}/view")
    public String detailPageView(@PathVariable("postId") Long postId, Model model, HttpSession session) {
        if (session.getAttribute("loginMemberId") == null) return "redirect:/";

        // getPost를 호출하여 조회수를 올리지 않고 데이터만 가져옵니다.
        model.addAttribute("post", new PostResponse(postService.getPost(postId)));
        return "detail";
    }
    /**
     * 게시글 수정 페이지 이동
     */
    @GetMapping("/posts/{postId}/edit")
    public String editPage(@PathVariable("postId") Long postId, Model model, HttpSession session) {
        // 보안: 로그인 확인
        if (session.getAttribute("loginMemberId") == null) return "redirect:/";

        // 기존 게시글 데이터를 가져와서 모델에 담습니다. (조회수 안 오르는 getPost 사용)
        Post post = postService.getPost(postId);
        model.addAttribute("post", new PostResponse(post));

        return "edit"; // edit.html 파일을 찾습니다.
    }
}