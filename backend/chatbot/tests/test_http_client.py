"""Verify process-owned pools are isolated, reusable, and closed at shutdown."""
import asyncio
from unittest import IsolatedAsyncioTestCase, mock

from chatbot.services import http_client


class AsyncHttpClientTests(IsolatedAsyncioTestCase):
    async def test_http1_connection_is_reused_after_retrieval_length_idle(self):
        """A loopback server sees one chat socket even after a six-second gap."""
        connections = []
        handlers = set()

        async def respond(reader, writer):
            handlers.add(asyncio.current_task())
            connections.append(writer)
            try:
                while True:
                    await reader.readuntil(b"\r\n\r\n")
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                    await writer.drain()
            except asyncio.IncompleteReadError:
                pass
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(respond, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            # Keep this deterministic even on a developer machine with proxies.
            with mock.patch.dict("os.environ", {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}):
                chat = http_client.get_openai_http_client()
                local = http_client.get_async_http_client()
            url = f"http://127.0.0.1:{port}/"
            self.assertEqual((await chat.get(url)).http_version, "HTTP/1.1")
            await local.get(url)
            await asyncio.sleep(6)
            self.assertEqual((await chat.get(url)).status_code, 200)
            self.assertEqual(len(connections), 2)
        finally:
            server.close()
            await http_client.close_async_http_client()
            for writer in connections:
                writer.close()
            if handlers:
                await asyncio.wait_for(asyncio.gather(*handlers), timeout=2)
            await server.wait_closed()

    async def asyncTearDown(self):
        await http_client.close_async_http_client()

    async def test_separate_clients_are_reused_and_closed(self):
        local = http_client.get_async_http_client()
        chat = http_client.get_openai_http_client()
        self.assertIs(local, http_client.get_async_http_client())
        self.assertIs(chat, http_client.get_openai_http_client())
        self.assertIsNot(local, chat)
        await http_client.close_async_http_client()
        self.assertTrue(local.is_closed)
        self.assertTrue(chat.is_closed)
        await http_client.close_async_http_client()
        self.assertIsNot(chat, http_client.get_openai_http_client())

    async def test_closed_client_is_recreated_without_replacing_local_client(self):
        local = http_client.get_async_http_client()
        chat = http_client.get_openai_http_client()
        await chat.aclose()
        self.assertIsNot(chat, http_client.get_openai_http_client())
        self.assertIs(local, http_client.get_async_http_client())

    async def test_openai_pool_retains_the_25_user_burst_across_retrieval(self):
        # HTTPX 0.27 has no public getters for transport limits.
        pool = http_client.get_openai_http_client()._transport._pool
        self.assertEqual(pool._max_connections, 25)
        self.assertEqual(pool._max_keepalive_connections, 25)
        self.assertEqual(pool._keepalive_expiry, 120.0)
        self.assertFalse(pool._http2)
