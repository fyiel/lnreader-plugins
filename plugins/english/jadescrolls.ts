import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const API_BASE = 'https://api.jadescrolls.com/api';
const CHAPTERS_PER_PAGE = 100;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchApi(url, {
    headers: { 'Cache-Control': 'no-store', 'If-None-Match': '' },
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      return fetchJson<T>(location);
    }
  }
  if (res.status === 304 || res.headers.get('content-length') === '0') {
    return {} as T;
  }
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

const novelIdCache: Record<string, string> = {};

interface JadeNovel {
  id: string;
  title: string;
  slug: string;
  synopsis: string;
  author_name: string;
  translator_name: string;
  cover_image: string;
  chapters_count: number;
  genres: { id: string; name: string }[];
  sub_genres: { id: string; name: string }[];
  metadata: {
    average_rating: number;
    language: string;
    novel_lead: string;
    status: string;
    content_rating: string;
    type: string;
    release_status: string;
  };
}

interface JadeChapter {
  id: string;
  title: string;
  slug: string;
  chapter_number: number;
  publish_at: string;
  status: string;
  type: string;
  volume: { id: string; title: string | null; number?: number };
}

interface JadeChapterContent {
  content: string;
  title: string;
  author_note: string | null;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; total_pages: number };
}

const releaseStatusMap: Record<string, string> = {
  COMPLETED: NovelStatus.Completed,
  ONGOING: NovelStatus.Ongoing,
  HIATUS: NovelStatus.OnHiatus,
  DROPPED: NovelStatus.Cancelled,
};

class JadeScrollsPlugin implements Plugin.PagePlugin {
  id = 'jadescrolls';
  name = 'JadeScrolls';
  icon = 'src/en/jadescrolls/icon.png';
  site = 'https://jadescrolls.com';
  version = '1.0.0';

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      page: String(pageNo),
      limit: '20',
      sortBy: filters?.sort?.value || 'weekly_views',
      sortOrder: 'desc',
    });

    if (filters?.genre?.value) {
      params.set('genre', filters.genre.value);
    }
    if (filters?.novelLead?.value) {
      params.set('novelLead', filters.novelLead.value);
    }
    if (filters?.type?.value) {
      params.set('type', filters.type.value);
    }

    const json = await fetchJson<PaginatedResponse<JadeNovel>>(
      `${API_BASE}/novels/list?${params.toString()}`,
    );

    return json.data.map(novel => ({
      name: novel.title,
      path: novel.slug,
      cover: novel.cover_image,
    }));
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel & { totalPages: number }> {
    const novel = await fetchJson<JadeNovel>(
      `${API_BASE}/novels?slug=${novelPath}`,
    );

    // cache the novel id for use in parsePage
    novelIdCache[novelPath] = novel.id;

    const allGenres = [
      ...novel.genres.map(g => g.name),
      ...novel.sub_genres.map(g => g.name),
    ];

    const sourceNovel: Plugin.SourceNovel & { totalPages: number } = {
      path: novelPath,
      name: novel.title,
      cover: novel.cover_image,
      summary: novel.synopsis?.replace(/<[^>]+>/g, ''),
      author: novel.author_name,
      artist: novel.translator_name || undefined,
      genres: allGenres.join(','),
      status:
        releaseStatusMap[novel.metadata?.release_status] || NovelStatus.Unknown,
      rating: novel.metadata?.average_rating
        ? novel.metadata.average_rating
        : undefined,
      totalPages: 0,
      chapters: [],
    };

    // fetch first page of chapters to get total count
    const chapJson = await fetchJson<PaginatedResponse<JadeChapter>>(
      `${API_BASE}/novels-chapter/${novel.id}/chapters/list?page=1&limit=${CHAPTERS_PER_PAGE}&sortOrder=asc&status=PUBLISHED`,
    );

    sourceNovel.totalPages = chapJson.meta.total_pages;
    sourceNovel.chapters = this.mapChapters(chapJson.data, novel.id);

    return sourceNovel;
  }

  async parsePage(novelPath: string, page: string): Promise<Plugin.SourcePage> {
    let novelId = novelIdCache[novelPath];
    if (!novelId) {
      const novel = await fetchJson<JadeNovel>(
        `${API_BASE}/novels?slug=${novelPath}`,
      );
      novelId = novel.id;
      novelIdCache[novelPath] = novelId;
    }

    const json = await fetchJson<PaginatedResponse<JadeChapter>>(
      `${API_BASE}/novels-chapter/${novelId}/chapters/list?page=${page}&limit=${CHAPTERS_PER_PAGE}&sortOrder=asc&status=PUBLISHED`,
    );

    return {
      chapters: this.mapChapters(json.data, novelId),
    };
  }

  private mapChapters(
    chapters: JadeChapter[],
    novelId: string,
  ): Plugin.ChapterItem[] {
    return chapters
      .filter(ch => ch.type === 'FREE')
      .map(ch => ({
        name: ch.title,
        path: `${novelId}/${ch.id}`,
        releaseTime: ch.publish_at,
        chapterNumber: ch.chapter_number,
      }));
  }

  async parseChapter(chapterPath: string): Promise<string> {
    // chapterPath = "novelId/chapterId"
    const [novelId, chapterId] = chapterPath.split('/');

    const chapter = await fetchJson<JadeChapterContent>(
      `${API_BASE}/novels-chapter/${novelId}/chapters/${chapterId}`,
    );

    let html = chapter.content || '';

    if (chapter.author_note) {
      html += `<hr/><b>Author's Note:</b><br/>${chapter.author_note}`;
    }

    return html;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const json = await fetchJson<{
      novels: {
        id: string;
        title: string;
        slug: string;
        cover_image: string;
      }[];
    }>(`${API_BASE}/public/search?query=${encodeURIComponent(searchTerm)}`);

    return (json.novels || []).map(novel => ({
      name: novel.title,
      path: novel.slug,
      cover: novel.cover_image,
    }));
  }

  resolveUrl = (path: string, isNovel?: boolean) =>
    isNovel ? `${this.site}/novel/${path}` : this.site;

  filters = {
    sort: {
      type: FilterTypes.Picker,
      label: 'Sort By',
      value: 'weekly_views',
      options: [
        { label: 'Popular (Weekly)', value: 'weekly_views' },
        { label: 'Rating', value: 'rating' },
        { label: 'Newest', value: 'created_at' },
      ],
    },
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Action', value: '34e5c717-8648-4cc1-b796-b6d02d49d170' },
        { label: 'Adult', value: '3eb04793-6bd8-4af7-8cde-34ae8e953cbd' },
        { label: 'Adventure', value: 'f815320a-34a8-45d7-a461-ef238857c2ed' },
        { label: 'Comedy', value: 'c3c870a5-825c-4f94-b5f6-f51a367fee02' },
        { label: 'Cultivation', value: 'a3d4e884-0651-44bf-a7e6-f456328e8c52' },
        { label: 'Drama', value: 'c4809ae2-f681-4ca8-8201-72278fd7df05' },
        { label: 'Ecchi', value: 'f65cc3cb-d5e2-45ec-8edf-6b6866a1af71' },
        { label: 'Fantasy', value: 'c8b536fa-9436-4b93-90fb-8a7bb2be8550' },
        { label: 'Game', value: '09acd8fa-028c-4bdd-8e76-b45d3a57badc' },
        { label: 'Harem', value: 'b22cbc2f-1815-47c0-9fbc-95e7e648b9be' },
        {
          label: 'Heart-warming',
          value: 'cca23f76-ec48-4432-9e4a-444cac40f2f3',
        },
        { label: 'Historical', value: 'afc657a7-2706-4641-9299-4d3a7d738537' },
        { label: 'Horror', value: '260b735b-70d8-49a5-81b8-a1e5c0a95d0b' },
        { label: 'Isekai', value: '955e790b-c378-4df4-9a91-5dd2d21a9f53' },
        { label: 'LGBTQ+', value: '7b8244e2-a9f4-4a60-ac46-888b46efad20' },
        {
          label: 'Martial Arts',
          value: '82892983-1c94-4a1e-a033-09b81f008ef1',
        },
        { label: 'Modern', value: 'bd91ba05-0c66-489c-b322-23d679dd5e4d' },
        { label: 'Mystery', value: '4bb0a253-558c-4e32-851d-2c2eabc2ce2e' },
        {
          label: 'Reincarnation',
          value: '8d63a221-0f55-4306-b5a1-344bf5f1a8a0',
        },
        { label: 'Romance', value: '8071a9d5-9e46-42ed-aa3a-bdaabe2b62a7' },
        { label: 'School Life', value: '6d769f67-d6e2-4287-a4b4-e8f4f40e91d2' },
        { label: 'Sci-Fi', value: '7551dfdd-5fea-4a46-a4dd-e4cfd666a40e' },
        { label: 'Seinen', value: '9a0698fe-00f9-4463-becc-bb44d0ed8508' },
        { label: 'Shounen', value: '93996ab2-684d-4b78-afda-3b35ef04afce' },
        {
          label: 'Slice of Life',
          value: 'f459e8b2-4976-427b-a576-7736ed6eaed9',
        },
        { label: 'Smut', value: '43e6547a-2784-4fdc-b208-099f8c7331ba' },
        {
          label: 'Supernatural',
          value: '5c6c028c-0623-4b6d-8e28-b2c4321e1311',
        },
        { label: 'Survival', value: '60410f83-6201-452d-9568-bf1fb9350961' },
        { label: 'System', value: '3f50190b-b296-4364-b7a9-9678d1ed2420' },
        { label: 'Thriller', value: '7f9ea4f3-df3d-44a5-8cbb-062b2d635029' },
        {
          label: 'Transmigration',
          value: '1e2bcdc8-b21b-4bd4-bdb9-db82642c4b89',
        },
        { label: 'Xianxia', value: '05123b95-5d18-4d67-8cb6-f04b9a25695b' },
      ],
    },
    novelLead: {
      type: FilterTypes.Picker,
      label: 'Novel Lead',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Male', value: 'MALE' },
        { label: 'Female', value: 'FEMALE' },
      ],
    },
    type: {
      type: FilterTypes.Picker,
      label: 'Novel Type',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Original', value: 'ORIGINAL' },
        { label: 'Translated', value: 'TRANSLATED' },
      ],
    },
  } satisfies Filters;
}

export default new JadeScrollsPlugin();
