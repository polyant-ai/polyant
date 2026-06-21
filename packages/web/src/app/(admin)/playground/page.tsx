// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatArea } from "./_components/chat-area";
import { useChat } from "./_hooks/use-chat";
import { useConversations } from "./_hooks/use-conversations";

const AUTH_STORAGE_PREFIX = "playground_auth_";

export default function PlaygroundPage() {
  const { conversations, loading, refresh } = useConversations();
  const chat = useChat("");
  const [authToken, setAuthToken] = useState("");
  const instanceSlug = chat.state.instanceSlug;

  // Refresh conversation list when streaming completes
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !chat.state.isStreaming) {
      refresh();
    }
    wasStreamingRef.current = chat.state.isStreaming;
  }, [chat.state.isStreaming, refresh]);

  // Load auth token from localStorage when instance changes
  useEffect(() => {
    if (instanceSlug) {
      const stored = localStorage.getItem(`${AUTH_STORAGE_PREFIX}${instanceSlug}`);
      setAuthToken(stored ?? "");
    } else {
      setAuthToken("");
    }
  }, [instanceSlug]);

  const handleAuthTokenChange = useCallback(
    (token: string) => {
      setAuthToken(token);
      if (instanceSlug) {
        if (token) {
          localStorage.setItem(`${AUTH_STORAGE_PREFIX}${instanceSlug}`, token);
        } else {
          localStorage.removeItem(`${AUTH_STORAGE_PREFIX}${instanceSlug}`);
        }
      }
    },
    [instanceSlug],
  );

  const handleSend = useCallback(
    (text: string) => {
      chat.sendMessage(text, authToken || undefined);
    },
    [chat, authToken],
  );

  const handleNewChat = useCallback(() => {
    chat.newChat();
  }, [chat]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      // Find the conversation to get the agentId (slug)
      const conv = conversations.find(
        (c) => c.conversationId === conversationId,
      );
      // Pass instanceSlug directly to loadConversation — avoids setInstance resetting state
      chat.loadConversation(conversationId, conv?.agentId ?? undefined);
    },
    [chat, conversations],
  );

  const handleInstanceChange = useCallback(
    (slug: string) => {
      chat.setInstance(slug);
    },
    [chat],
  );

  return (
    <div className="-m-6 flex h-[calc(100vh-4rem)]">
      <ChatArea
        messages={chat.state.messages}
        isStreaming={chat.state.isStreaming}
        instanceSlug={chat.state.instanceSlug}
        error={chat.state.error}
        conversations={conversations}
        conversationsLoading={loading}
        activeConversationId={chat.state.conversationId}
        authToken={authToken}
        onAuthTokenChange={handleAuthTokenChange}
        onSend={handleSend}
        onStop={chat.stopStreaming}
        onInstanceChange={handleInstanceChange}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
      />
    </div>
  );
}
