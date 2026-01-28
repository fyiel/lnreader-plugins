import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';

interface NovelsHubNovel {
  id: number;
  slug: string;
  postTitle: string;
  postContent: string;
  featuredImage: string;
  author: string;
  artist: string;
  seriesStatus: string;
  seriesType: string;
  genres: Array<{ id: number; name: string }>;
  totalViews: number;
  lastChapterAddedAt: string;
  isNovel: boolean;
}

interface NovelsHubChapter {
  id: number;
  slug: string;
  number: number;
  title: string;
  createdAt: string;
  isLocked: boolean;
  isAccessible: boolean;
  isLockedByCoins: boolean;
  contentHasImages: boolean;
}

class NovelsHubPlugin implements Plugin.PluginBase {
  id = 'novelshub';
  name = 'NovelsHub';
  version = '1.0.0';
  icon = 'src/en/novelshub/icon.png';
  site = 'https://novelshub.org/';
  apiUrl = 'https://api.novelshub.org/api';

  imageRequestInit?: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://novelshub.org',
    },
  };

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = `${this.apiUrl}/query?page=${pageNo}&perPage=24`;

    if (filters?.status?.value) {
      url += `&seriesStatus=${filters.status.value}`;
    } else {
      url += '&seriesStatus=';
    }

    // genre filter uses OR logic, api limitation
    const selectedGenres = filters?.genres?.value;
    if (selectedGenres && selectedGenres.length > 0) {
      url += `&genreIds=${selectedGenres.join(',')}`;
    }

    // seriesType is available but we don't use it since we only want novels
    url += '&seriesType=NOVEL';

    const response = await fetchApi(url, {
      headers: {
        Referer: this.site,
        Accept: 'application/json',
      },
    });
    const data = await response.json();

    const novels: Plugin.NovelItem[] = [];
    const posts: NovelsHubNovel[] = data.posts || [];

    for (const novel of posts) {
      if (!novel.isNovel) continue;

      novels.push({
        name: novel.postTitle,
        path: `series/${novel.slug}`,
        cover: novel.featuredImage || defaultCover,
      });
    }

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    // extract slug from path (series/{slug})
    const slug = novelPath.replace('series/', '');

    const postUrl = `${this.apiUrl}/post?postSlug=${slug}`;
    const postResponse = await fetchApi(postUrl, {
      headers: {
        Referer: this.site,
        Accept: 'application/json',
      },
    });
    const postData = await postResponse.json();
    const post = postData.post;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: post.postTitle || 'Untitled',
      cover: post.featuredImage || defaultCover,
      summary: this.stripHtml(post.postContent || ''),
      author: post.author || '',
      artist: post.artist || '',
      status: this.parseStatus(post.seriesStatus),
      genres:
        post.genres?.map((g: { name: string }) => g.name.trim()).join(', ') ||
        '',
    };

    // this looks bad, but this is what we need to do to work with how NovelsHub's API handles chapter pagination (it doesn't)
    const chapters: Plugin.ChapterItem[] = [];
    const maxTake = 999;
    let skip = 0;
    let totalChapterCount = 0;

    do {
      const chaptersUrl = `${this.apiUrl}/chapters?postId=${post.id}&take=${maxTake}&skip=${skip}`;
      const chaptersResponse = await fetchApi(chaptersUrl, {
        headers: {
          Referer: this.site,
          Accept: 'application/json',
        },
      });
      const chaptersData = await chaptersResponse.json();
      totalChapterCount = chaptersData.totalChapterCount || 0;
      const rawChapters: NovelsHubChapter[] = chaptersData.post?.chapters || [];

      for (const ch of rawChapters) {
        const lockIndicator = ch.isLockedByCoins ? '🔒' : '';
        const illustrationIndicator = ch.contentHasImages ? '🖼️' : '';
        const chapterName = ch.title
          ? `${lockIndicator}${illustrationIndicator} Chapter ${ch.number}: ${ch.title}`
          : `${lockIndicator}${illustrationIndicator} Chapter ${ch.number}`;

        chapters.push({
          name: chapterName,
          path: `series/${slug}/${ch.slug}`,
          chapterNumber: ch.number,
          releaseTime: ch.createdAt,
        });
      }

      skip += maxTake;
    } while (skip < totalChapterCount);

    chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    // path format: series/{novelSlug}/{chapterSlug}
    const parts = chapterPath.split('/');
    const novelSlug = parts[1];
    const chapterSlug = parts[2];

    const url = `${this.apiUrl}/chapter?mangaslug=${novelSlug}&chapterslug=${chapterSlug}`;
    const response = await fetchApi(url, {
      headers: {
        Referer: this.site,
        Accept: 'application/json',
      },
    });
    const data = await response.json();

    if (data.chapter?.content) {
      return data.chapter.content;
    }

    if (data.error || data.chapter?.isLocked) {
      return '<p>This chapter is locked or requires purchase.</p>';
    }

    return '<p>Chapter content not available.</p>';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // only return results on first page since the API doesn't paginate search
    if (pageNo > 1) return [];

    const url = `${this.apiUrl}/query?searchTerm=${encodeURIComponent(searchTerm)}`;
    const response = await fetchApi(url, {
      headers: {
        Referer: this.site,
        Accept: 'application/json',
      },
    });
    const data = await response.json();

    const novels: Plugin.NovelItem[] = [];
    const seenSlugs = new Set<string>();
    const posts: NovelsHubNovel[] = data.posts || [];

    for (const novel of posts) {
      if (!novel.isNovel) continue;
      if (seenSlugs.has(novel.slug)) continue;
      seenSlugs.add(novel.slug);

      novels.push({
        name: novel.postTitle,
        path: `series/${novel.slug}`,
        cover: novel.featuredImage || defaultCover,
      });
    }

    return novels;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  private parseStatus(status: string): string {
    switch (status?.toUpperCase()) {
      case 'ONGOING':
        return NovelStatus.Ongoing;
      case 'COMPLETED':
        return NovelStatus.Completed;
      case 'HIATUS':
        return NovelStatus.OnHiatus;
      default:
        return NovelStatus.Unknown;
    }
  }

  filters = {
    status: {
      type: FilterTypes.Picker,
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'ONGOING' },
        { label: 'Completed', value: 'COMPLETED' },
        { label: 'Hiatus', value: 'HIATUS' },
        { label: 'Cancelled', value: 'CANCELLED' },
        { label: 'Dropped', value: 'DROPPED' },
        { label: 'Mass Released', value: 'MASS_RELEASED' },
        { label: 'Coming Soon', value: 'COMING_SOON' },
      ],
    },
    genres: {
      type: FilterTypes.CheckboxGroup,
      label: 'Genres',
      value: [],
      options: [
        { label: 'Reincarnation', value: '1' },
        { label: 'System', value: '2' },
        { label: 'Mystery', value: '3' },
        { label: 'Action', value: '4' },
        { label: 'Detective Conan', value: '5' },
        { label: 'Isekai', value: '6' },
        { label: 'Weak to Strong', value: '7' },
        { label: 'Anime', value: '8' },
        { label: 'Romance', value: '9' },
        { label: 'School Life', value: '10' },
        { label: 'Wuxia', value: '11' },
        { label: 'Fantasy', value: '12' },
        { label: 'Drama', value: '13' },
        { label: 'Comedy', value: '14' },
        { label: 'Martial Arts', value: '15' },
        { label: 'Supernatural', value: '16' },
        { label: 'Cunning Protagonist', value: '17' },
        { label: 'Light Novel', value: '18' },
        { label: 'Military', value: '19' },
        { label: 'Harem', value: '20' },
        { label: 'Modern Day', value: '21' },
        { label: 'Transmigration', value: '22' },
        { label: 'Urban Fantasy', value: '23' },
        { label: 'Adopted Sister', value: '24' },
        { label: 'Male Protagonist', value: '25' },
        { label: 'Faction Building', value: '26' },
        { label: 'Superpowers', value: '27' },
        { label: 'Science', value: '28' },
        { label: 'Fiction', value: '29' },
        { label: 'Space-Time Travel', value: '30' },
        { label: 'Dimensional Travel', value: '31' },
        { label: 'Magic', value: '32' },
        { label: 'Wizards', value: '33' },
        { label: 'Adult', value: '34' },
        { label: 'Life', value: '35' },
        { label: 'Adventure', value: '36' },
        { label: 'Shounen', value: '37' },
        { label: 'Psychological', value: '38' },
        { label: 'Academy', value: '39' },
        { label: 'Character Growth', value: '40' },
        { label: 'Game', value: '41' },
        { label: 'Elements', value: '42' },
        { label: 'Transported into a Game World', value: '43' },
        { label: 'Gender Bender', value: '44' },
        { label: 'Slice of Life', value: '45' },
        { label: 'Sports', value: '46' },
        { label: 'Revenge', value: '47' },
        { label: 'Hard Work', value: '48' },
        { label: 'Survival', value: '49' },
        { label: 'Historical', value: '50' },
        { label: 'Healing Romance', value: '51' },
        { label: 'Shoujo', value: '52' },
        { label: 'Possession', value: '53' },
        { label: 'Regression', value: '54' },
        { label: 'Seinen', value: '55' },
        { label: 'Sci-Fi', value: '56' },
        { label: 'Tragedy', value: '57' },
        { label: 'Shounen (Alt)', value: '58' },
        { label: 'Mature', value: '59' },
        { label: 'Cultivation Elements', value: '60' },
        { label: 'Secret Organization', value: '61' },
        { label: 'Horror', value: '62' },
        { label: 'Weak to Strong (Alt)', value: '63' },
        { label: 'Crime', value: '64' },
        { label: 'Police', value: '65' },
        { label: 'Urban Life', value: '66' },
        { label: 'Workplace', value: '67' },
        { label: 'Finance', value: '68' },
        { label: 'Business Management', value: '69' },
        { label: 'Wall Street', value: '70' },
        { label: 'Beautiful Female Leads', value: '71' },
        { label: 'Wealth Building', value: '72' },
        { label: 'Stock Market', value: '73' },
        { label: 'Second Chance', value: '74' },
        { label: 'Silicon Valley', value: '75' },
        { label: 'Financial Warfare', value: '76' },
        { label: 'Dystopia', value: '77' },
        { label: 'Another World', value: '78' },
        { label: 'Thriller', value: '79' },
        { label: 'Genius Protagonist', value: '80' },
        { label: 'Business / Management', value: '81' },
        { label: 'Gallery', value: '82' },
        { label: 'Investor', value: '83' },
        { label: 'Obsession', value: '84' },
        { label: 'Misunderstandings', value: '85' },
        { label: 'Ecchi', value: '86' },
        { label: 'Yuri', value: '87' },
        { label: 'Shoujo AI', value: '88' },
        { label: 'Summoned to a Tower', value: '89' },
        { label: 'Game Element', value: '90' },
        { label: 'Xianxia', value: '91' },
        { label: 'Serial Killers', value: '92' },
        { label: 'Murders', value: '93' },
        { label: 'Unconditional Love', value: '94' },
        { label: 'Demons', value: '95' },
        { label: 'Regret', value: '96' },
        { label: 'Josei', value: '97' },
        { label: 'Murim', value: '98' },
        { label: 'Dark Fantasy', value: '99' },
        { label: 'Game World', value: '100' },
        { label: 'Religious', value: '101' },
        { label: 'Territory Management', value: '102' },
        { label: 'Genius', value: '103' },
        { label: 'Scoundrel', value: '104' },
        { label: 'Nobility', value: '105' },
        { label: 'Tower Climbing', value: '106' },
        { label: 'Professional', value: '107' },
        { label: 'Overpowered', value: '108' },
        { label: 'Singer', value: '109' },
        { label: 'Veteran', value: '110' },
        { label: 'Effort', value: '111' },
        { label: 'Manager', value: '112' },
        { label: 'Supernatural Ability', value: '113' },
        { label: 'Devour or Absorption', value: '114' },
        { label: 'Artifact', value: '115' },
        { label: 'Mortal Path', value: '116' },
        { label: 'Decisive and Ruthless', value: '117' },
        { label: 'Idol', value: '118' },
        { label: 'Heroes', value: '119' },
        { label: 'Cultivation', value: '120' },
        { label: 'Love Triangle', value: '121' },
        { label: 'First Love', value: '122' },
        { label: 'Reverse Harem', value: '123' },
        { label: 'One-Sided Love', value: '124' },
        { label: 'Smut', value: '125' },
        { label: 'War', value: '126' },
        { label: 'Apocalypse', value: '127' },
        { label: 'Chaos', value: '128' },
        { label: 'Magic and Sword', value: '129' },
        { label: 'Mecha', value: '130' },
        { label: 'Actor', value: '131' },
        { label: 'MMORPG', value: '132' },
        { label: 'Virtual Reality', value: '133' },
        { label: 'Xuanhuan', value: '134' },
        { label: 'Yaoi', value: '135' },
        { label: 'Matur', value: '136' },
        { label: 'Ghost Story', value: '137' },
        { label: 'GL', value: '138' },
        { label: 'Necrosmith', value: '139' },
        { label: 'Necromancer', value: '140' },
        { label: 'Blacksmith', value: '141' },
        { label: 'Artist', value: '142' },
        { label: 'Childcare', value: '143' },
        { label: 'Streaming', value: '144' },
        { label: 'All-Rounder', value: '145' },
        { label: 'OP (Munchkin)', value: '146' },
        { label: 'Gambling', value: '147' },
        { label: 'Money', value: '148' },
        { label: 'R18', value: '149' },
        { label: 'Tsundere', value: '150' },
        { label: 'Proactive Protagonist', value: '151' },
        { label: 'Cute Story', value: '152' },
        { label: 'Alternate Universe', value: '153' },
        { label: 'Movie', value: '154' },
        { label: 'Adhesion', value: '155' },
        { label: 'Illusion', value: '156' },
        { label: 'Villain Role', value: '157' },
        { label: 'Modern Fantasy', value: '158' },
        { label: 'Hunter', value: '159' },
        { label: 'TS', value: '160' },
        { label: 'Munchkin', value: '161' },
        { label: 'Tower', value: '162' },
        { label: 'Hyundai', value: '163' },
        { label: 'Modern Fantasy (Alt)', value: '164' },
        { label: 'Alchemy', value: '165' },
        { label: 'World War', value: '166' },
        { label: 'War Hero', value: '167' },
        { label: 'Alternative History', value: '168' },
        { label: 'Famous Family', value: '169' },
        { label: 'Dark', value: '170' },
        { label: 'Yandere', value: '171' },
        { label: 'Ghost', value: '172' },
        { label: 'Catfight', value: '173' },
        { label: 'Sauce', value: '174' },
        { label: 'Food', value: '175' },
        { label: 'Cook', value: '176' },
        { label: 'Cyberpunk', value: '177' },
        { label: 'Mind Control', value: '178' },
        { label: 'Hypnosis', value: '179' },
        { label: 'Mukbang/Cooking', value: '180' },
        { label: 'Fusion', value: '181' },
        { label: 'Awakening', value: '182' },
        { label: 'Farming', value: '183' },
        { label: 'Pure Love', value: '184' },
        { label: 'Slave', value: '185' },
        { label: 'Kingdom Building', value: '186' },
        { label: 'Political', value: '187' },
        { label: 'Redemption', value: '188' },
        { label: 'AI', value: '189' },
        { label: 'Showbiz', value: '190' },
        { label: 'Orthodox', value: '191' },
        { label: 'Entertainment Industry', value: '192' },
        { label: 'Writer', value: '193' },
        { label: 'Healing', value: '194' },
        { label: 'Medical', value: '195' },
        { label: 'Mana', value: '196' },
        { label: 'Medieval', value: '197' },
        { label: 'Schemes', value: '198' },
        { label: 'Love', value: '199' },
        { label: 'Marriage', value: '200' },
        { label: 'Netrori', value: '201' },
        { label: 'Gods', value: '202' },
        { label: 'Crazy Love Interest', value: '203' },
        { label: 'MMA', value: '204' },
        { label: 'Ice Age', value: '205' },
        { label: 'Management', value: '206' },
        { label: 'Female Protagonist', value: '207' },
        { label: 'Royalty', value: '208' },
        { label: 'Mob Protagonist', value: '209' },
        { label: 'Climbing', value: '210' },
        { label: 'Middle Age', value: '211' },
        { label: 'Romance Fantasy', value: '212' },
        { label: 'Cooking', value: '213' },
        { label: 'Return', value: '214' },
        { label: 'Northern Air Force', value: '215' },
        { label: 'National Management', value: '216' },
        { label: 'Immortality', value: '217' },
        { label: 'Fist Techniques', value: '218' },
        { label: 'Retired Expert', value: '219' },
        { label: 'Returnee', value: '220' },
        { label: 'Hidden Identity', value: '221' },
        { label: 'Zombie', value: '222' },
        { label: 'Knight', value: '223' },
        { label: 'NTL', value: '224' },
        { label: 'Bitcoins', value: '225' },
        { label: 'Crypto', value: '226' },
        { label: 'Actia', value: '227' },
        { label: 'Brainwashing', value: '228' },
        { label: 'Tentacles', value: '229' },
        { label: 'Slime', value: '230' },
        { label: 'Cultivators', value: '231' },
        { label: 'Bully', value: '232' },
        { label: 'University', value: '233' },
        { label: 'BL', value: '234' },
        { label: 'Omegaverse', value: '235' },
        { label: "Girl's Love", value: '236' },
        { label: 'Theater', value: '237' },
        { label: 'Broadcasting', value: '238' },
        { label: 'Success', value: '239' },
        { label: 'Internet Broadcasting', value: '240' },
        { label: 'Rape', value: '241' },
        { label: 'Madman', value: '242' },
        { label: 'Soccer', value: '243' },
        { label: 'Solo Protagonist', value: '244' },
        { label: 'Underworld', value: '245' },
        { label: 'Politics', value: '246' },
        { label: 'Army', value: '247' },
        { label: 'Three Kingdoms', value: '248' },
        { label: 'Conspiracy', value: '249' },
        { label: 'Possessive Characters', value: '250' },
        { label: 'European Ambience', value: '251' },
        { label: 'Love Interest Falls in Love First', value: '252' },
        { label: 'Reincarnated in a Game World', value: '253' },
        { label: 'Male Yandere', value: '254' },
        { label: 'Handsome Male Lead', value: '255' },
        { label: 'Monsters', value: '256' },
        { label: 'Urban Legend', value: '257' },
        { label: 'Modern', value: '258' },
        { label: 'Summoning', value: '259' },
        { label: 'LightNovel', value: '260' },
        { label: 'Vampire', value: '261' },
        { label: 'Game Development', value: '262' },
        { label: 'Normalization', value: '263' },
        { label: 'Game Fantasy', value: '264' },
        { label: 'VirtualReality', value: '265' },
        { label: 'Infinite Money Glitch', value: '266' },
        { label: 'Tycoon', value: '267' },
      ],
    },
  } satisfies Filters;
}

export default new NovelsHubPlugin();
