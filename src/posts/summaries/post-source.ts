import { runtimeConfig } from '../../config/runtime-config.js';
import type { Model } from 'mongoose';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  Post,
  PostType,
} from '../../mongo/models.js';

const MAX_INPUT_CHARS = runtimeConfig.POST_SUMMARY_MAX_INPUT_CHARS;

/** A labelled piece of a post, e.g. its body or one video's transcript. */
export interface PostSourcePart {
  label: string;
  text: string;
}

export interface PostSource {
  parts: PostSourcePart[];
  /** One line for the log. */
  description: string;
  /** Ready videos whose transcript is not written yet. */
  untranscribedVideos: number;
}

/**
 * What a post says, for the AI to read: a blog's title and content, or a
 * post's text plus the transcript of each ready video (only `onlyMediaId`'s
 * when given), within MAX_INPUT_CHARS.
 */
export async function readPostSource(
  post: Post,
  mediaAssets: Model<MediaAsset>,
  onlyMediaId?: string,
): Promise<PostSource> {
  if (post.type === PostType.BLOG) {
    const blog = post.blog;
    if (!blog) {
      return {
        parts: [],
        description: 'BLOG without content',
        untranscribedVideos: 0,
      };
    }
    return {
      parts: clipParts([
        { label: 'Blog title', text: blog.title },
        { label: 'Blog content', text: blog.content },
      ]),
      description: `BLOG, title ${blog.title.length} chars, content ${blog.content.length} chars`,
      untranscribedVideos: 0,
    };
  }
  const parts: PostSourcePart[] = [];
  const body = post.body ?? '';
  if (body) parts.push({ label: 'Post text', text: body });
  const videos = await mediaAssets
    .find({ postId: post.id, status: MediaStatus.READY, discardedAt: null })
    .sort({ position: 1 })
    .select('transcript durationSec captionStatus')
    .exec();
  const described: string[] = [`POST, body ${body.length} chars`];
  let untranscribedVideos = 0;
  videos.forEach((video, index) => {
    if (onlyMediaId && video.id !== onlyMediaId) return;
    described.push(describeVideo(video));
    if (video.transcript) {
      parts.push({
        label: `What video ${index + 1} says`,
        text: video.transcript,
      });
      return;
    }
    if (
      video.captionStatus === CaptionStatus.NONE ||
      video.captionStatus === CaptionStatus.TRANSCRIBING
    ) {
      untranscribedVideos += 1;
    }
  });
  if (videos.length === 0) described.push('no video');
  return {
    parts: clipParts(parts),
    description: described.join(', '),
    untranscribedVideos,
  };
}

/** Keeps the whole source within MAX_INPUT_CHARS, cutting the last parts first. */
export function clipParts(parts: PostSourcePart[]): PostSourcePart[] {
  const clipped: PostSourcePart[] = [];
  let room = MAX_INPUT_CHARS;
  for (const part of parts) {
    if (room <= 0) break;
    const text = part.text.trim().slice(0, room);
    room -= text.length;
    if (text) clipped.push({ label: part.label, text });
  }
  return clipped;
}

function describeVideo(
  video: Pick<
    MediaAsset,
    'id' | 'durationSec' | 'captionStatus' | 'transcript'
  >,
): string {
  const duration =
    video.durationSec === null ? '?s' : `${Math.round(video.durationSec)}s`;
  const transcript = video.transcript
    ? `transcript ${video.transcript.length} chars`
    : 'no transcript';
  return `video ${video.id} ${duration} ${video.captionStatus} ${transcript}`;
}
