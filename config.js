// Адзнакі («лайкі») і каментары захоўваюцца ў GitHub Discussions праз giscus (https://giscus.app).
// Пакуль поля пустыя, блок адзнак на старонках не паказваецца. Як атрымаць значэнні — гл. README.md.
window.SONGBOOK_CONFIG = {
  giscus: {
    repo: '',        // напрыклад 'imia/muzhchynskija-pesni'
    repoId: '',      // data-repo-id з giscus.app
    category: '',    // напрыклад 'Announcements' або ўласная катэгорыя «Песні»
    categoryId: ''   // data-category-id з giscus.app
  },
  // Прапановы правак ад наведвальнікаў (Supabase, праект pesni). Пакуль поля пустыя, кнопак правак на сайце няма.
  // Project URL і anon / publishable key з Supabase → Project Settings → API. Яны не сакрэтныя: даступ абараняюць
  // правілы ў базе (supabase/corrections.sql). Ключ service_role / secret сюды ніколі не ўстаўляць.
  corrections: {
    url: '',         // напрыклад 'https://abcd1234.supabase.co'
    key: ''          // anon / publishable key
  }
};
