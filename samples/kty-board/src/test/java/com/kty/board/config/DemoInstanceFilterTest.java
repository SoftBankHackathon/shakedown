package com.kty.board.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.*;

class DemoInstanceFilterTest {

    @Test
    void HOSTNAME이_있으면_그대로_쓴다() {
        // Docker는 컨테이너 ID를 HOSTNAME으로 준다. 이미 서버마다 다르니 바꾸지 않는다.
        assertEquals("3f2a9c1b7d4e", DemoInstanceFilter.instanceId("3f2a9c1b7d4e"));
    }

    @Test
    void HOSTNAME이_없으면_서버마다_다른_무작위_id를_만든다() {
        // Cloud Run에는 HOSTNAME이 없다. 예전에는 2대가 모두 "local"이라 어느 서버가 답했는지 구별할 수 없었다.
        String a = DemoInstanceFilter.instanceId(null);
        String b = DemoInstanceFilter.instanceId(null);

        assertNotEquals(a, b);
        assertTrue(a.matches("i-[0-9a-f]{8}"), a);
        assertTrue(DemoInstanceFilter.instanceId("").matches("i-[0-9a-f]{8}"));
    }

    @Test
    void 같은_서버는_요청마다_같은_id를_헤더로_낸다() throws Exception {
        DemoInstanceFilter filter = new DemoInstanceFilter();
        String id = idOf(filter);

        // 헤더를 아예 안 붙이면 두 번 다 null이라 같다고 통과한다. 그래서 먼저 값이 규칙대로 붙었는지 본다.
        // 테스트 JVM에 HOSTNAME이 있으면 그 값, 없으면 무작위 i-xxxxxxxx다.
        assertNotNull(id, "X-Instance-Id 헤더가 없다");
        assertTrue(id.equals(System.getenv("HOSTNAME")) || id.matches("i-[0-9a-f]{8}"), id);
        assertEquals(id, idOf(filter));
    }

    private static String idOf(DemoInstanceFilter filter) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(new MockHttpServletRequest("GET", "/"), response, new MockFilterChain());
        return response.getHeader("X-Instance-Id");
    }
}
