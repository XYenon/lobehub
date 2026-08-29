import debug from 'debug';

import { renderGuestCopy, renderGuestTruncated } from '../../replyTemplate';
import type { BotReplyLocale } from '../const';
import type { BotMessageAttachment, MessengerContent } from '../types';
import { messengerContentText } from '../types';
import type { TelegramApi } from './api';
import {
  getTelegramGuestSession,
  saveTelegramGuestSession,
  type TelegramGuestSession,
} from './guestSession';
import { markdownToTelegramHTML } from './markdownToHTML';
import { decodeGuestInlineMessageId, encodeGuestInlineMessageId } from './threadId';

const log = debug('lobe-server:bot:telegram-guest-outbound');

const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;

const escapeTelegramHTML = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const attachmentFallbackText = (
  attachment: BotMessageAttachment,
  index: number,
  lng?: BotReplyLocale,
): string => {
  const label = escapeTelegramHTML(attachment.name?.trim() || `Attachment ${index + 1}`);
  if (!attachment.fetchUrl) {
    return `${label}: ${renderGuestCopy('guestMediaUnavailable', lng)}`;
  }
  return `<a href="${escapeTelegramHTML(attachment.fetchUrl)}">${label}</a>`;
};

const guestBodyLimit = (mediaType: TelegramGuestSession['mediaType']): number =>
  mediaType === 'photo' ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;

const prepareGuestText = (
  text: string,
  attachments: BotMessageAttachment[] | undefined,
  lng?: BotReplyLocale,
  limit = TELEGRAM_TEXT_LIMIT,
): { displayText: string; storedText: string } => {
  const fallbackLines =
    attachments?.map((att, index) => attachmentFallbackText(att, index, lng)) ?? [];
  const fallbackText = fallbackLines.join('\n');
  let combinedText = fallbackText || text;
  if (text.trim() && fallbackText) {
    combinedText = `${text}\n\n${fallbackText}`;
  }
  if (combinedText.length <= limit) {
    return { displayText: combinedText, storedText: text };
  }

  const truncatedNotice = `\n\n${renderGuestTruncated(limit, lng)}`;
  const overflowNotice = renderGuestCopy('guestAttachmentOverflow', lng);
  const fallbackBudget = limit - truncatedNotice.length - overflowNotice.length;
  const includedFallbacks: string[] = [];
  for (const line of fallbackLines) {
    const candidate = [...includedFallbacks, line].join('\n');
    if (candidate.length > fallbackBudget) break;
    includedFallbacks.push(line);
  }
  const omittedAttachments = includedFallbacks.length < fallbackLines.length;
  const fallbackSection = [
    ...includedFallbacks,
    ...(omittedAttachments ? [overflowNotice] : []),
  ].join('\n');
  const suffix = fallbackSection ? `${truncatedNotice}\n\n${fallbackSection}` : truncatedNotice;
  const storedText = text.slice(0, Math.max(0, limit - suffix.length));
  return {
    displayText: `${storedText}${suffix}`,
    storedText,
  };
};

const canApplyMedia = (
  attachments: BotMessageAttachment[] | undefined,
  caption: string,
): attachments is [BotMessageAttachment & { fetchUrl: string }] =>
  attachments?.length === 1 &&
  attachments[0]?.type === 'image' &&
  Boolean(attachments[0].fetchUrl) &&
  caption.length <= TELEGRAM_CAPTION_LIMIT;

const applyMedia = async (
  api: TelegramApi,
  inlineMessageId: string,
  attachment: BotMessageAttachment & { fetchUrl: string },
  caption: string,
): Promise<boolean> => {
  try {
    await api.editInlineMessageMedia({
      caption: caption.trim() ? caption : undefined,
      inlineMessageId,
      mediaType: 'photo',
      source: { url: attachment.fetchUrl },
    });
    return true;
  } catch (error) {
    log('editInlineMessageMedia failed: %O', error);
    return false;
  }
};

/**
 * Telegram distinguishes text vs media edits. After `editMessageMedia` the
 * inline message is a photo, so later body updates must use caption edits.
 * Guest Mode keeps the photo rather than trying to convert it back to text.
 */
const editGuestMessageBody = async (
  api: TelegramApi,
  inlineMessageId: string,
  text: string,
  mediaType: TelegramGuestSession['mediaType'],
): Promise<void> => {
  if (mediaType === 'photo') {
    await api.editInlineMessageCaption({ caption: text, inlineMessageId });
    return;
  }
  await api.editMessageText(inlineMessageId, text);
};

export const deliverGuestCreate = async (
  api: TelegramApi,
  sessionScope: string,
  threadId: string,
  content: MessengerContent,
): Promise<{ id: string }> => {
  const text = messengerContentText(content);
  const attachments = typeof content === 'string' ? undefined : content.attachments;
  const session = await getTelegramGuestSession(sessionScope, threadId);
  if (!session || (!session.guestQueryId && !session.inlineMessageId)) {
    throw new Error(`Telegram guest reply has no session for thread ${threadId}`);
  }

  if (!session.inlineMessageId) {
    return answerGuestQuery(api, sessionScope, threadId, session, text, attachments);
  }

  return editExistingGuest(api, sessionScope, threadId, session, text, attachments, {
    replaceText: false,
  });
};

export const deliverGuestEdit = async (
  api: TelegramApi,
  sessionScope: string,
  threadId: string,
  messageId: string,
  content: MessengerContent,
): Promise<void> => {
  const text = messengerContentText(content);
  const attachments = typeof content === 'string' ? undefined : content.attachments;
  const session = (await getTelegramGuestSession(sessionScope, threadId)) ?? {
    guestQueryId: '',
  };
  const inlineFromId = decodeGuestInlineMessageId(messageId) ?? session.inlineMessageId;
  if (!inlineFromId) {
    throw new Error(`Telegram guest edit has no inline_message_id for thread ${threadId}`);
  }
  await editExistingGuest(
    api,
    sessionScope,
    threadId,
    { ...session, inlineMessageId: inlineFromId },
    text,
    attachments,
    { replaceText: true },
  );
};

const answerGuestQuery = async (
  api: TelegramApi,
  sessionScope: string,
  threadId: string,
  session: TelegramGuestSession,
  text: string,
  attachments: BotMessageAttachment[] | undefined,
): Promise<{ id: string }> => {
  const prepared = prepareGuestText(
    text,
    attachments,
    session.locale,
    guestBodyLimit(session.mediaType),
  );
  const { inline_message_id: inlineMessageId } = await api.answerGuestArticle(
    session.guestQueryId,
    prepared.displayText,
  );
  let mediaType = session.mediaType;
  if (
    canApplyMedia(attachments, text) &&
    (await applyMedia(api, inlineMessageId, attachments[0], text))
  ) {
    mediaType = 'photo';
  }

  await saveTelegramGuestSession(sessionScope, threadId, {
    ...session,
    inlineMessageId,
    lastText: prepared.storedText,
    mediaType,
  });
  return { id: encodeGuestInlineMessageId(inlineMessageId) };
};

const editExistingGuest = async (
  api: TelegramApi,
  sessionScope: string,
  threadId: string,
  session: TelegramGuestSession,
  text: string,
  attachments: BotMessageAttachment[] | undefined,
  options: { replaceText: boolean },
): Promise<{ id: string }> => {
  const inlineMessageId = session.inlineMessageId!;
  let nextText = text;
  if (
    !options.replaceText &&
    session.lastText?.trim() &&
    text.trim() &&
    session.lastText !== text
  ) {
    nextText = `${session.lastText}\n\n${text}`;
  }
  const prepared = prepareGuestText(
    nextText,
    attachments,
    session.locale,
    guestBodyLimit(session.mediaType),
  );
  let mediaType = session.mediaType;

  if (canApplyMedia(attachments, nextText)) {
    const delivered = await applyMedia(api, inlineMessageId, attachments[0], nextText);
    if (delivered) {
      mediaType = 'photo';
    } else if (prepared.displayText.trim()) {
      await editGuestMessageBody(api, inlineMessageId, prepared.displayText, mediaType);
    }
  } else if (prepared.displayText.trim()) {
    await editGuestMessageBody(api, inlineMessageId, prepared.displayText, mediaType);
  }

  await saveTelegramGuestSession(sessionScope, threadId, {
    ...session,
    inlineMessageId,
    lastText: prepared.storedText,
    mediaType,
  });
  return { id: encodeGuestInlineMessageId(inlineMessageId) };
};

/**
 * Convert a Chat SDK postable payload into the HTML + attachment shape
 * Guest Mode outbound expects. Callbacks already HTML-format via
 * `formatMarkdown`; local `thread.post({ markdown })` still needs conversion.
 */
export const messengerContentFromPostable = (message: unknown): MessengerContent => {
  if (typeof message === 'string') {
    return markdownToTelegramHTML(message);
  }
  if (!message || typeof message !== 'object') return '';
  const record = message as {
    attachments?: Array<{
      data?: Buffer;
      mimeType?: string;
      name?: string;
      size?: number;
      type?: BotMessageAttachment['type'];
      url?: string;
    }>;
    markdown?: string;
    text?: string;
  };
  const rawText = record.markdown ?? record.text ?? '';
  const content = record.markdown ? markdownToTelegramHTML(rawText) : rawText;
  const attachments = record.attachments?.flatMap((att) => {
    if (!att.type) return [];
    return [
      {
        data: att.data?.toString('base64'),
        fetchUrl: att.url,
        mimeType: att.mimeType,
        name: att.name,
        size: att.size,
        type: att.type,
      } satisfies BotMessageAttachment,
    ];
  });
  if (!attachments?.length) return content;
  return { attachments, content };
};
