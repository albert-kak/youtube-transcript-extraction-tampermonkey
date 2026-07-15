# YouTube Transcript Extractor

Tampermonkey userscript for extracting transcript text from YouTube watch pages.

The script primarily uses YouTube's modern `get_panel` API:

- `https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false`

If the live page state is dirty after YouTube SPA navigation, the script will try to recover by fetching the current watch page HTML again and parsing fresh transcript-related data from it.

## Demo

![Demo](assets/demo.gif)

## Files

- [youtube-transcript-extractor.user.js](/Users/kahkiit/Documents/projects/youtube-transcript-extraction-tampermonkey/youtube-transcript-extractor.user.js)

## Features

- Extract transcript text from `youtube.com/watch` pages
- Copy transcript with timestamps
- Copy transcript as plain text
- Download transcript as `.txt`
- Handle most in-site YouTube navigation without requiring a manual refresh
- Fallback to caption track parsing when `get_panel` data is unavailable

## Installation

1. Install the Tampermonkey browser extension.
2. Open the Tampermonkey dashboard.
3. Click `Create a new script`.
4. Delete the default template.
5. Paste the full contents of [youtube-transcript-extractor.user.js](/Users/kahkiit/Documents/projects/youtube-transcript-extraction-tampermonkey/youtube-transcript-extractor.user.js).
6. Save the script.
7. Make sure the script is enabled.

## Usage

1. Open a YouTube video page:
   - `https://www.youtube.com/watch?v=...`
2. Wait for the page to load.
3. Click the `提取转录` button at the bottom-right corner.
4. Use the panel actions:
   - `重新提取`
   - `复制带时间戳`
   - `复制纯文本`
   - `下载 TXT`

## How It Works

The script uses several layers of data sources, in roughly this order:

1. Live YouTube page data such as:
   - `movie_player`
   - `ytd-watch-flexy`
   - `ytd-app`
2. Modern transcript payload for `PAmodern_transcript_view`
3. Fresh watch-page HTML fetched from the current page URL
4. Caption track fallback (`timedtext`) if transcript panel data is unavailable

This matters because YouTube is an SPA and some older state objects can remain stale after clicking into another video.

## Known Limitations

- Some videos do not expose transcript or caption data at all.
- Some videos may be region-restricted, age-restricted, or otherwise unavailable to the current client context.
- If YouTube changes its internal response shape, the script may need to be updated.
- Shorts pages are not supported.

## Troubleshooting

If the button does not appear:

- Confirm you are on a `watch` page, not Shorts.
- Confirm the script is enabled in Tampermonkey.
- Refresh the page once.

If extraction fails:

- Try a video that visibly has subtitles/transcript on YouTube itself.
- Refresh the page and retry.
- Check the browser console for script errors.

If you see:

- `当前视频没有可用字幕轨道，或者 YouTube 没返回 transcript 数据。`

That usually means the current video does not expose transcript/caption data to the current page context.

## Notes

This script is built for practical extraction, not for API stability. YouTube internal endpoints are not public stable APIs, so some maintenance should be expected over time.
