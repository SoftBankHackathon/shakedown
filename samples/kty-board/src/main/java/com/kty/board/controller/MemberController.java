package com.kty.board.controller;

import com.kty.board.domain.Member;
import com.kty.board.repository.MemberRepository;
import com.kty.board.service.MemberService;
import jakarta.servlet.http.HttpSession;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Controller
@RequiredArgsConstructor
public class MemberController {

    private final MemberService memberService;
    private final MemberRepository memberRepository;

    /**
     * 회원가입 처리
     */
    @PostMapping("/join")
    public String join(@RequestParam String email,
                       @RequestParam String nickname,
                       @RequestParam String password,
                       Model model) {
        try {
            Member member = Member.builder()
                    .email(email)
                    .nickname(nickname)
                    .password(password)
                    .build();

            memberService.join(member);
            return "redirect:/";

        } catch (IllegalStateException e) {
            model.addAttribute("errorMessage", e.getMessage());
            model.addAttribute("email", email);
            model.addAttribute("nickname", nickname);
            return "join";
        }
    }

    /**
     * 로그인 처리 (수정완료)
     */
    @PostMapping("/login")
    public String login(@RequestParam String email,
                        @RequestParam String password,
                        HttpSession session,
                        Model model) { // Model 추가
        try {
            // 1. 이메일로 회원 조회 (실패 시 "가입되지 않은 이메일입니다." 던짐)
            Member member = memberRepository.findByEmail(email)
                    .orElseThrow(() -> new IllegalArgumentException("가입되지 않은 이메일입니다."));

            // 2. 비밀번호 체크 (실패 시 "비밀번호가 일치하지 않습니다." 던짐)
            if (!member.getPassword().equals(password)) {
                throw new IllegalArgumentException("비밀번호가 일치하지 않습니다.");
            }

            // 3. 로그인 성공 시 세션 저장
            session.setAttribute("loginMemberId", member.getId());
            session.setAttribute("nickname", member.getNickname());

            return "redirect:/board";

        } catch (IllegalArgumentException e) {
            // 🚨 예외 발생 시 서비스/레포지토리에서 던진 메시지를 모델에 담음
            model.addAttribute("loginErrorMessage", e.getMessage());
            // 입력했던 이메일은 유지
            model.addAttribute("email", email);
            return "login"; // login.html로 복귀
        }
    }

    /**
     * 로그아웃 처리
     */
    @GetMapping("/logout")
    public String logout(HttpSession session) {
        session.invalidate();
        return "redirect:/";
    }
}