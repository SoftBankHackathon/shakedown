package com.kty.board.service;

import com.kty.board.domain.Member;
import com.kty.board.repository.MemberRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@Transactional // 테스트 후 데이터를 롤백해줘서 DB를 깔끔하게 유지합니다.
class MemberServiceTest {

    @Autowired MemberService memberService;
    @Autowired MemberRepository memberRepository;

    @Test
    void 회원가입_성공() {
        // given (준비)
        Member member = Member.builder()
                .email("test@test.com")
                .nickname("테스터")
                .password("1234")
                .build();

        // when (실행)
        Long savedId = memberService.join(member);

        // then (검증)
        assertEquals(member.getEmail(), memberRepository.findById(savedId).get().getEmail());
    }

    @Test
    void 중복_회원_예외() {
        // given
        // password를 꼭 넣어줘야 합니다!
        Member member1 = Member.builder()
                .email("same@test.com")
                .nickname("kty1")
                .password("1234") // 추가
                .build();

        Member member2 = Member.builder()
                .email("same@test.com")
                .nickname("kty2")
                .password("1234") // 추가
                .build();

        // when & then
        memberService.join(member1);

        // 두 번째 가입 시 이메일 중복으로 IllegalStateException이 터져야 성공!
        assertThrows(IllegalStateException.class, () -> {
            memberService.join(member2);
        });
    }
}