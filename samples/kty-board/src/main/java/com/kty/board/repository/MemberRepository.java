package com.kty.board.repository;

import com.kty.board.domain.Member;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface MemberRepository extends JpaRepository<Member, Long> {
    // 이메일로 중복 가입 여부를 확인하기 위해 추가
    Optional<Member> findByEmail(String email);
}