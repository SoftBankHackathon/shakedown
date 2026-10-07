package com.kty.board.service;

import com.kty.board.domain.Comment;
import com.kty.board.domain.Member;
import com.kty.board.domain.Post;
import com.kty.board.repository.CommentRepository;
import com.kty.board.repository.MemberRepository;
import com.kty.board.repository.PostRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
@RequiredArgsConstructor
public class CommentService {

    private final CommentRepository commentRepository;
    private final PostRepository postRepository;
    private final MemberRepository memberRepository;

    /**
     * 댓글 작성 (이 메서드 하나로 통합합니다)
     */
    @Transactional
    public Long writeComment(Long postId, Long memberId, String content) {
        // 1. 게시글 조회 (없으면 에러)
        Post post = postRepository.findById(postId)
                .orElseThrow(() -> new IllegalArgumentException("게시글이 존재하지 않습니다."));

        // 2. 작성자 조회 (없으면 에러)
        Member member = memberRepository.findById(memberId)
                .orElseThrow(() -> new IllegalArgumentException("회원이 존재하지 않습니다."));

        // 3. 댓글 생성 및 저장
        Comment comment = Comment.builder()
                .content(content)
                .post(post)
                .member(member)
                .build();

        commentRepository.save(comment);
        return comment.getId();
    }
    @Transactional
    public void deleteComment(Long commentId, String nickname) {
        Comment comment = commentRepository.findById(commentId)
                .orElseThrow(() -> new IllegalArgumentException("해당 댓글이 없습니다."));

        // 본인 확인 로직 🔥
        if (!comment.getMember().getNickname().equals(nickname)) {
            throw new RuntimeException("본인의 댓글만 처리할 수 있습니다.");
        }

        commentRepository.delete(comment);
    }
    /**
     * 댓글 수정 로직
     */
    @Transactional
    public void updateComment(Long commentId, String newContent, String nickname) {
        // 1. 수정할 댓글을 DB에서 찾아옵니다.
        Comment comment = commentRepository.findById(commentId)
                .orElseThrow(() -> new IllegalArgumentException("해당 댓글이 존재하지 않습니다."));

        // 2. [보안] 댓글 작성자와 현재 로그인한 사용자가 같은지 확인합니다.
        if (!comment.getMember().getNickname().equals(nickname)) {
            throw new RuntimeException("본인의 댓글만 처리할 수 있습니다.");
        }

        // 3. 내용 수정 (Dirty Checking에 의해 트랜잭션 종료 시 DB에 반영됨)
        comment.update(newContent);
    }
}