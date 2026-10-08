package com.kty.board.controller;

import com.kty.board.service.CommentService;
import jakarta.servlet.http.HttpSession;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Controller
@RequiredArgsConstructor
@RequestMapping("/api/comments") // 여기서 이미 /api/comments를 선언했습니다.
public class CommentController {

    private final CommentService commentService;

    /**
     * 댓글 등록 처리 (주소: POST /api/comments)
     */
    @PostMapping
    public String writeComment(@RequestParam("postId") Long postId,
                               @RequestParam("content") String content,
                               HttpSession session) {
        Long loginMemberId = (Long) session.getAttribute("loginMemberId");
        if (loginMemberId == null) return "redirect:/";

        commentService.writeComment(postId, loginMemberId, content);
        return "redirect:/posts/" + postId + "/view";
    }

    /**
     * 댓글 삭제 처리 (주소: POST /api/comments/{commentId}/delete)
     */
    @PostMapping("/{commentId}/delete") // 👈 /comments/ 제거!
    public String deleteComment(@PathVariable("commentId") Long commentId,
                                @RequestParam("postId") Long postId,
                                HttpSession session) {
        String loginNickname = (String) session.getAttribute("nickname");
        if (loginNickname == null) return "redirect:/";

        commentService.deleteComment(commentId, loginNickname);
        return "redirect:/posts/" + postId + "/view";
    }

    /**
     * 댓글 수정 처리 (주소: POST /api/comments/{commentId}/edit)
     */
    @PostMapping("/{commentId}/edit") // 👈 /comments/ 제거!
    public String updateComment(@PathVariable("commentId") Long commentId,
                                @RequestParam("postId") Long postId,
                                @RequestParam("content") String content,
                                HttpSession session) {
        String loginNickname = (String) session.getAttribute("nickname");
        if (loginNickname == null) return "redirect:/";

        commentService.updateComment(commentId, content, loginNickname);
        return "redirect:/posts/" + postId + "/view";
    }
}