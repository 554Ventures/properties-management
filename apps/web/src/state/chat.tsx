// Global assistant state (build-order task 9). ChatProvider owns the drawer
// open state (`?chat=open` deep link — layout state, not a route, per §8),
// the lazily-created session, and the transcript: messages from GET plus the
// optimistic user message and the in-flight assistant message assembled from
// SSE events (ARCHITECTURE §5) by a pure reducer.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AskUserQuestionAnswer,
  ChatMessage,
  ChatSession,
  ContentBlock,
  CreateChatSessionInput,
  SseEvent,
  SseToolActivity,
} from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { postSse } from '../api/sse';

export type ChatStatus = 'idle' | 'streaming' | 'awaiting_input' | 'error';

/** `{ screen, entityId? }` — the screen context sent on session creation. */
export type ScreenContext = NonNullable<CreateChatSessionInput['context']>;

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  status: ChatStatus;
  toolActivity: SseToolActivity | null;
  /** Assistant message currently being assembled (or paused on a question). */
  streamingMessageId: string | null;
  /** Submitted answers by questionId — keeps answered questions frozen. */
  answers: Record<string, AskUserQuestionAnswer>;
  /** Screen-reader text, updated only on block_complete / message_complete. */
  announcement: string;
  errorMessage: string | null;
}

const initialState: ChatState = {
  sessionId: null,
  messages: [],
  status: 'idle',
  toolActivity: null,
  streamingMessageId: null,
  answers: {},
  announcement: '',
  errorMessage: null,
};

type ChatAction =
  | { type: 'session_created'; session: ChatSession }
  | { type: 'messages_loaded'; messages: ChatMessage[] }
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'answer_submitted'; answer: AskUserQuestionAnswer }
  | { type: 'send_failed'; message: string }
  | { type: 'sse_event'; event: SseEvent };

/** Sets blocks[index], padding any gap with empty text blocks (never holes). */
function setBlock(blocks: ContentBlock[], index: number, block: ContentBlock): ContentBlock[] {
  const next = blocks.slice();
  while (next.length < index) next.push({ type: 'text', text: '' });
  next[index] = block;
  return next;
}

function updateAssistantMessage(
  state: ChatState,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatState {
  if (state.messages.some((m) => m.id === messageId)) {
    return {
      ...state,
      messages: state.messages.map((m) => (m.id === messageId ? update(m) : m)),
    };
  }
  const fresh: ChatMessage = {
    id: messageId,
    sessionId: state.sessionId ?? 'pending',
    role: 'assistant',
    blocks: [],
    createdAt: new Date().toISOString(),
  };
  return { ...state, messages: [...state.messages, update(fresh)] };
}

/** Announcement text per completed block (§8: not per token). */
function describeBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case 'text':
      return null; // covered by the message_complete announcement
    case 'chart':
      return `The Hearth assistant added a chart: ${block.title}.`;
    case 'data_table':
      return block.title
        ? `The Hearth assistant added a table: ${block.title}.`
        : 'The Hearth assistant added a table.';
    case 'action_card':
      return `The Hearth assistant suggested an action: ${block.title}.`;
    case 'ask_user_question':
      return `The Hearth assistant asked: ${block.question}`;
  }
}

function applySseEvent(state: ChatState, event: SseEvent): ChatState {
  switch (event.event) {
    case 'message_start': {
      // Idempotent — a resumed turn may re-announce the same messageId.
      const next = updateAssistantMessage(state, event.data.messageId, (m) => m);
      return {
        ...next,
        status: 'streaming',
        streamingMessageId: event.data.messageId,
        errorMessage: null,
      };
    }
    case 'block_start': {
      // Structured blocks arrive whole via block_complete; only text blocks
      // need an in-progress placeholder for the deltas to append into.
      if (!state.streamingMessageId || event.data.blockType !== 'text') return state;
      return updateAssistantMessage(state, state.streamingMessageId, (m) =>
        m.blocks[event.data.index]
          ? m
          : { ...m, blocks: setBlock(m.blocks, event.data.index, { type: 'text', text: '' }) },
      );
    }
    case 'text_delta': {
      if (!state.streamingMessageId) return state;
      return updateAssistantMessage(state, state.streamingMessageId, (m) => {
        const existing = m.blocks[event.data.index];
        const text =
          existing?.type === 'text' ? existing.text + event.data.delta : event.data.delta;
        return { ...m, blocks: setBlock(m.blocks, event.data.index, { type: 'text', text }) };
      });
    }
    case 'block_complete': {
      if (!state.streamingMessageId) return state;
      const next = updateAssistantMessage(state, state.streamingMessageId, (m) => ({
        ...m,
        blocks: setBlock(m.blocks, event.data.index, event.data.block),
      }));
      return { ...next, announcement: describeBlock(event.data.block) ?? next.announcement };
    }
    case 'tool_activity':
      return { ...state, toolActivity: event.data };
    case 'awaiting_input':
      return {
        ...state,
        status: 'awaiting_input',
        toolActivity: null,
        streamingMessageId: event.data.messageId,
      };
    case 'message_complete':
      return {
        ...state,
        status: 'idle',
        toolActivity: null,
        streamingMessageId: null,
        announcement: 'The Hearth assistant finished replying.',
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        errorMessage: event.data.message,
        toolActivity: null,
        streamingMessageId: null,
      };
  }
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'session_created':
      return {
        ...state,
        sessionId: action.session.id,
        messages: state.messages.map((m) =>
          m.sessionId === 'pending' ? { ...m, sessionId: action.session.id } : m,
        ),
      };
    case 'messages_loaded': {
      // Server history first, then any local messages it doesn't know yet.
      const serverIds = new Set(action.messages.map((m) => m.id));
      const localOnly = state.messages.filter((m) => !serverIds.has(m.id));
      return { ...state, messages: [...action.messages, ...localOnly] };
    }
    case 'user_message':
      return {
        ...state,
        status: 'streaming',
        errorMessage: null,
        messages: [...state.messages, action.message],
      };
    case 'answer_submitted':
      return {
        ...state,
        status: 'streaming',
        errorMessage: null,
        answers: { ...state.answers, [action.answer.questionId]: action.answer },
      };
    case 'send_failed':
      return {
        ...state,
        status: 'error',
        errorMessage: action.message,
        toolActivity: null,
      };
    case 'sse_event':
      return applySseEvent(state, action.event);
  }
}

/** Fallback screen context derived from the current route. */
function contextFromPath(pathname: string): ScreenContext {
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!first) return { screen: 'dashboard' };
  return second ? { screen: first, entityId: second } : { screen: first };
}

export interface ChatContextValue {
  open: boolean;
  openDrawer: () => void;
  /** Deep-link entry (e.g. Reports): opens the drawer with explicit context. */
  openWithContext: (context: ScreenContext) => void;
  close: () => void;
  messages: ChatMessage[];
  status: ChatStatus;
  toolActivity: SseToolActivity | null;
  answers: Record<string, AskUserQuestionAnswer>;
  announcement: string;
  errorMessage: string | null;
  send: (text: string) => void;
  answer: (answer: AskUserQuestionAnswer) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

let localMessageId = 0;

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const [open, setOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const queryClient = useQueryClient();

  const sessionIdRef = useRef<string | null>(null);
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const pendingContextRef = useRef<ScreenContext | null>(null);
  const locationRef = useRef(location.pathname);
  const abortRef = useRef<AbortController | null>(null);
  locationRef.current = location.pathname;

  // ?chat=open deep link — opening is driven by the URL; closing clears it.
  useEffect(() => {
    if (searchParams.get('chat') === 'open') setOpen(true);
  }, [searchParams]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const syncParam = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) params.set('chat', 'open');
          else params.delete('chat');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const openDrawer = useCallback(() => {
    setOpen(true);
    syncParam(true);
  }, [syncParam]);

  const close = useCallback(() => {
    setOpen(false);
    syncParam(false);
  }, [syncParam]);

  const openWithContext = useCallback(
    (context: ScreenContext) => {
      pendingContextRef.current = context;
      openDrawer();
    },
    [openDrawer],
  );

  /** Lazily creates the session (once) with the current screen context. */
  const ensureSession = useCallback((): Promise<string> => {
    if (sessionIdRef.current) return Promise.resolve(sessionIdRef.current);
    if (!sessionPromiseRef.current) {
      const context = pendingContextRef.current ?? contextFromPath(locationRef.current);
      sessionPromiseRef.current = (async () => {
        const session = await api.post<ChatSession>('/chat/sessions', { context });
        sessionIdRef.current = session.id;
        dispatch({ type: 'session_created', session });
        const history = await api
          .get<ChatMessage[]>(`/chat/sessions/${session.id}/messages`)
          .catch(() => [] as ChatMessage[]);
        if (history.length > 0) dispatch({ type: 'messages_loaded', messages: history });
        return session.id;
      })().catch((error: unknown) => {
        sessionPromiseRef.current = null;
        throw error;
      });
    }
    return sessionPromiseRef.current;
  }, []);

  const handleEvent = useCallback(
    (event: SseEvent) => {
      dispatch({ type: 'sse_event', event });
      if (event.event === 'message_complete') {
        // The assistant may have generated reports / actioned insights.
        void queryClient.invalidateQueries({ queryKey: ['reports'] });
        void queryClient.invalidateQueries({ queryKey: ['insights'] });
      }
    },
    [queryClient],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      dispatch({
        type: 'user_message',
        message: {
          id: `local-${++localMessageId}`,
          sessionId: sessionIdRef.current ?? 'pending',
          role: 'user',
          blocks: [{ type: 'text', text: trimmed }],
          createdAt: new Date().toISOString(),
        },
      });
      void ensureSession()
        .then((sessionId) => {
          abortRef.current?.abort();
          abortRef.current = postSse(`/chat/sessions/${sessionId}/messages`, { text: trimmed }, {
            onEvent: handleEvent,
          });
        })
        .catch(() => {
          dispatch({
            type: 'send_failed',
            message: 'Could not reach the Hearth assistant. Check your connection and try again.',
          });
        });
    },
    [ensureSession, handleEvent],
  );

  const answer = useCallback(
    (value: AskUserQuestionAnswer) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      dispatch({ type: 'answer_submitted', answer: value });
      abortRef.current?.abort();
      // The /answer response is a new SSE stream continuing the same turn.
      abortRef.current = postSse(`/chat/sessions/${sessionId}/answer`, value, {
        onEvent: handleEvent,
      });
    },
    [handleEvent],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      open,
      openDrawer,
      openWithContext,
      close,
      messages: state.messages,
      status: state.status,
      toolActivity: state.toolActivity,
      answers: state.answers,
      announcement: state.announcement,
      errorMessage: state.errorMessage,
      send,
      answer,
    }),
    [open, openDrawer, openWithContext, close, state, send, answer],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within <ChatProvider>');
  return ctx;
}
