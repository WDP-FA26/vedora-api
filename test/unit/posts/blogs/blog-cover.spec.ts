import {
  coverFromContent,
  isVideoUrl,
  MAX_COVER_URL_LENGTH,
} from '../../../../src/posts/blogs/blog-cover.js';

const httpsOnly = (url: string) => url.startsWith('https://');

describe('coverFromContent', () => {
  it('returns the first image on a line of its own', () => {
    const content = [
      'Mở bài.',
      '![Ảnh 1](https://cdn.example.com/first.jpg)',
      '![Ảnh 2](https://cdn.example.com/second.jpg)',
    ].join('\n\n');

    expect(coverFromContent(content, httpsOnly)).toBe(
      'https://cdn.example.com/first.jpg',
    );
  });

  it('ignores images inside a paragraph', () => {
    const content =
      'Xem ảnh ![inline](https://cdn.example.com/inline.jpg) này.';

    expect(coverFromContent(content, httpsOnly)).toBeNull();
  });

  it('skips videos, disallowed links and over-long URLs', () => {
    const long = `https://cdn.example.com/${'a'.repeat(MAX_COVER_URL_LENGTH)}.jpg`;
    const content = [
      '![](https://res.cloudinary.com/demo/video/upload/clip.mp4)',
      '![](http://cdn.example.com/plain.jpg)',
      `![](${long})`,
      '![](https://cdn.example.com/ok.png)',
    ].join('\n\n');

    expect(coverFromContent(content, httpsOnly)).toBe(
      'https://cdn.example.com/ok.png',
    );
  });

  it('returns null when there is no image', () => {
    expect(coverFromContent('Chỉ có chữ.', httpsOnly)).toBeNull();
  });
});

describe('isVideoUrl', () => {
  it.each([
    ['https://res.cloudinary.com/demo/video/upload/v1/clip', true],
    ['https://cdn.example.com/clip.MP4?x=1', true],
    ['https://cdn.example.com/photo.jpg', false],
  ])('%s -> %s', (url, expected) => {
    expect(isVideoUrl(url)).toBe(expected);
  });
});
