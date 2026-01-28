import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';

class DreamyTranslationsPlugin implements Plugin.PluginBase {
  id = 'dreamytranslations';
  name = 'Dreamy Translations';
  version = '1.7.0';
  icon = 'src/en/dreamytranslations/icon.png';
  site = 'https://dreamy-translations.com';

  imageRequestInit?: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://dreamy-translations.com/',
    },
  };

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Use default filters if none provided
    if (!filters) filters = this.filters;

    const url = `${this.site}/series`;
    const response = await fetchApi(url);
    const body = await response.text();

    let illustrationCounts: Record<string, number> | null = null;
    const needsIllustrationData =
      filters.illustrated.value || filters.sort.value === 'illustrations';
    if (needsIllustrationData) {
      try {
        const illustrationResponse = await fetchApi(
          `${this.site}/api/illustration-counts`,
          {
            headers: {
              Accept: 'application/json',
              Referer: this.site,
            },
          },
        );
        const illustrationData = await illustrationResponse.json();
        illustrationCounts = illustrationData.counts || {};
      } catch {}
    }

    // novel data from RSC payload (escaped JSON)
    // \"id\":123,\"title\":\"...\",\"slug\":\"...\",...\"total_chapters\":50,...\"view_count\":1000,...\"last_updated_at\":\"...\"
    interface NovelData {
      id: string;
      title: string;
      slug: string;
      cover: string;
      totalChapters: number;
      viewCount: number;
      lastUpdatedAt: string;
    }

    const novelsData: NovelData[] = [];
    const novelRegex =
      /\\"id\\":(\d+),\\"title\\":\\"(.*?)\\",\\"slug\\":\\"([^\\]+)\\"/g;

    let match;
    while ((match = novelRegex.exec(body)) !== null) {
      const id = match[1];
      const title = this.unescapeJson(match[2]);
      const slug = match[3];

      const afterMatch = body.substring(match.index, match.index + 2000);
      const chaptersMatch = afterMatch.match(/\\"total_chapters\\":(\d+)/);
      const viewsMatch = afterMatch.match(/\\"view_count\\":(\d+)/);
      const updatedMatch = afterMatch.match(
        /\\"last_updated_at\\":\\"([^"\\]+)\\"/,
      );
      const coverMatch = afterMatch.match(/\\"cover\\":\\"(https:[^"\\]+)\\"/);

      novelsData.push({
        id,
        title,
        slug,
        cover: coverMatch
          ? coverMatch[1].replace(/\\\//g, '/')
          : `https://supabase.dreamy-translations.com/storage/v1/object/public/covers/${id}/cover.jpeg`,
        totalChapters: chaptersMatch ? parseInt(chaptersMatch[1]) : 0,
        viewCount: viewsMatch ? parseInt(viewsMatch[1]) : 0,
        lastUpdatedAt: updatedMatch ? updatedMatch[1] : '',
      });
    }

    const seen = new Set<string>();
    const uniqueNovels = novelsData.filter(n => {
      if (seen.has(n.slug)) return false;
      seen.add(n.slug);
      return true;
    });

    let filteredNovels = uniqueNovels;
    if (filters.illustrated.value && illustrationCounts) {
      filteredNovels = uniqueNovels.filter(n => n.id in illustrationCounts!);
    }

    const sortBy = filters.sort.value;
    filteredNovels.sort((a, b) => {
      switch (sortBy) {
        case 'chapters':
          return b.totalChapters - a.totalChapters;
        case 'views':
          return b.viewCount - a.viewCount;
        case 'updates':
          return (
            new Date(b.lastUpdatedAt).getTime() -
            new Date(a.lastUpdatedAt).getTime()
          );
        case 'illustrations':
          return (
            (illustrationCounts?.[b.id] || 0) -
            (illustrationCounts?.[a.id] || 0)
          );
        case 'title':
        default:
          return a.title.localeCompare(b.title);
      }
    });

    return filteredNovels.map(n => {
      const illustCount = illustrationCounts?.[n.id];
      const illustBadge = illustCount ? `(🖼️${illustCount}) ` : '';
      return {
        name: illustBadge + this.decodeHtmlEntities(n.title),
        path: `novel/${n.slug}`,
        cover: n.cover,
      };
    });
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = `${this.site}/${novelPath}`;
    const response = await fetchApi(url);
    const body = await response.text();

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: 'Untitled',
    };

    const idMatch = body.match(/\\"project\\":\s*\{\\"id\\":\s*(\d+)/);

    const titleMatch = body.match(/\\"title\\":\\"([^\\]+)\\"/);

    // \"synopsis\":\"...\", (stop at \", which ends the value)
    const synopsisMatch = body.match(
      /\\"synopsis\\":\\"(.*?)\\",\\"short_synopsis\\"/,
    );

    if (titleMatch) {
      novel.name = this.unescapeJson(titleMatch[1]);
    }
    if (synopsisMatch) {
      novel.summary = this.unescapeJson(synopsisMatch[1]);
    }

    const coverMatch = body.match(/\\"cover\\":\\"(https:[^"\\]+)\\"/);
    const coverUrlMatch = body.match(/\\"coverUrl\\":\\"(https:[^"\\]+)\\"/);
    if (coverMatch) {
      novel.cover = this.unescapeJson(coverMatch[1]);
    } else if (coverUrlMatch) {
      novel.cover = this.unescapeJson(coverUrlMatch[1]);
    }

    // \"author\":\"...\""
    const authorMatch = body.match(/\\"author\\":\\"([^\\]+)\\"/);
    if (authorMatch) {
      novel.author = authorMatch[1];
    }

    // \"genres\":[\"...\",\"...\"]
    const genresMatch = body.match(/\\"genres\\":\s*\[([^\]]+)\]/);
    if (genresMatch) {
      const genres = genresMatch[1].match(/\\"([^\\]+)\\"/g);
      if (genres) {
        novel.genres = genres.map(g => g.replace(/\\"/g, '')).join(', ');
      }
    }

    novel.status = NovelStatus.Ongoing;

    // illustration chapter indices from the RSC payload
    // \"chapterIndex\":96
    const illustratedChapters = new Set<number>();
    const illustrationRegex = /\\"chapterIndex\\":(\d+)/g;
    let illustMatch;
    while ((illustMatch = illustrationRegex.exec(body)) !== null) {
      illustratedChapters.add(parseInt(illustMatch[1]));
    }

    // chapters from the RSC payload
    const chapters: Plugin.ChapterItem[] = [];
    const novelSlug = novelPath.replace('novel/', '');

    // {\"id\":123,\"title\":\"...\",\"slug\":\"...\",\"index\":1,\"free\":true,\"status\":\"published\"
    const chapterRegex =
      /\{\\"id\\":\d+,\\"title\\":\\"([^\\]+)\\",\\"slug\\":\\"[^\\]+\\",\\"index\\":(\d+),\\"free\\":(true|false),\\"status\\":\\"([^\\]+)\\"/g;
    let match;
    while ((match = chapterRegex.exec(body)) !== null) {
      const [, title, indexStr, , status] = match;
      const index = parseInt(indexStr);
      if (status === 'published') {
        const hasIllustration = illustratedChapters.has(index);
        const illustrationIcon = hasIllustration ? '🖼️ ' : '';
        const cleanTitle = this.unescapeJson(title).replace(
          /\s*\(Illustration\)\s*$/i,
          '',
        );
        chapters.push({
          name: `${illustrationIcon}Chapter ${index}: ${cleanTitle}`,
          path: `novel/${novelSlug}/chapter/${index}`,
          chapterNumber: index,
        });
      }
    }

    const uniqueChapters = chapters.filter(
      (ch, idx, self) =>
        idx === self.findIndex(c => c.chapterNumber === ch.chapterNumber),
    );
    uniqueChapters.sort(
      (a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0),
    );

    novel.chapters = uniqueChapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = `${this.site}/${chapterPath}`;
    const response = await fetchApi(url);
    const body = await response.text();
    const $ = parseHTML(body);

    const proseContainer = $('[class*="prose"]').first();
    if (proseContainer.length) {
      proseContainer
        .find(
          'nav, button, [class*="navigation"], a[href*="/chapter/"], .flex.items-center.justify-between, [class*="sticky"], [class*="fixed"]',
        )
        .remove();

      let content = proseContainer.html() || '';

      content = content
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .trim();

      if (content.length > 100) {
        return content;
      }
    }

    const contentMatch = body.match(/\\"content\\":\\"((?:[^"\\]|\\.)*)\\"/);
    if (contentMatch && contentMatch[1].length > 100) {
      const rawContent = this.unescapeJson(contentMatch[1]);
      return rawContent
        .split('\n\n')
        .filter((p: string) => p.trim())
        .map((p: string) => `<p>${p.trim()}</p>`)
        .join('\n');
    }

    return 'Chapter content not available.';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const allNovels = await this.popularNovels(pageNo, {
      showLatestNovels: false,
      filters: this.filters,
    });

    const searchLower = searchTerm.toLowerCase();
    return allNovels.filter(novel =>
      novel.name.toLowerCase().includes(searchLower),
    );
  }

  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  private unescapeJson(text: string): string {
    return text
      .replace(/\\\\n/g, '\n')
      .replace(/\\\\r/g, '\r')
      .replace(/\\\\t/g, '\t')
      .replace(/\\\\"/g, '"')
      .replace(/\\\\\\\\/g, '\\\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }

  filters = {
    sort: {
      label: 'Sort By',
      value: 'title',
      options: [
        { label: 'Title', value: 'title' },
        { label: 'Chapters', value: 'chapters' },
        { label: 'Views', value: 'views' },
        { label: 'Updates', value: 'updates' },
        { label: 'Illustrations', value: 'illustrations' },
      ],
      type: FilterTypes.Picker,
    },
    illustrated: {
      label: 'Illustrated Only',
      value: false,
      type: FilterTypes.Switch,
    },
  } satisfies Filters;
}

export default new DreamyTranslationsPlugin();
