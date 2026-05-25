document.addEventListener('DOMContentLoaded', function () {
    // Défilement infini
    var url = window.location.href;
    var timer = null;

    const storageKey = 'infiniteScroll_' + url;
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    var page = saved ? saved.page : 2;
    const homeTitle = document.title;

    function scrollToPosition(target, duration = 300) {
        const start = window.scrollY;
        const distance = target - start;
        const startTime = performance.now();

        function easeOutExpo(t) {
            return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        }

        function step(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            window.scrollTo(0, start + distance * easeOutExpo(progress));
            if (progress < 1) requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
    }

    async function loadPage(pageNum) {
        const nextPage = url + 'page/' + pageNum;
        const response = await fetch(nextPage);
        const content = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');
        const grid = doc.querySelector('.grid');
        if (grid) {
            document.querySelector('.site-main').appendChild(grid);
            requestAnimationFrame(() => {
                grid.classList.add('fade-in');
            });
        }
    }

    async function restorePages() {
        for (let p = 2; p < page; p++) {
            await loadPage(p);
        }
        if (saved && saved.scrollY) {
            scrollToPosition(saved.scrollY);
        }
    }

    if (saved && saved.page > 2) {
        restorePages();
    }

    window.addEventListener('scroll', function () {
        sessionStorage.setItem(storageKey, JSON.stringify({
            page: page,
            scrollY: window.scrollY
        }));

        const scrolledTo90 =
            window.scrollY + window.innerHeight >= document.documentElement.scrollHeight * 0.9;

        if (scrolledTo90) {
            if (timer) return;
            timer = setTimeout(async function () {
                if (page <= max_pages) {
                    if (url.charAt(url.length - 1) !== '/') {
                        url = url + '/';
                    }
                    await loadPage(page);
                    page = page + 1;
                }
                timer = null;
            }, 250);
        } else {
            clearTimeout(timer);
            timer = null;
        }
    });

    // Popover
    (function () {
        const dialog = document.querySelector('.article-popover');
        const content = dialog.querySelector('.article-popover__content');
        const closeBtn = dialog.querySelector('.article-popover__close');
        let currentIndex = -1;
        let isAnimating = false;
        let mode = 'article';

        function getLinks() {
            return Array.from(document.querySelectorAll('.site-main .post-link'));
        }

        function getOrigin(el) {
            const rect = el.getBoundingClientRect();
            const x = ((rect.left + rect.width / 2) / window.innerWidth) * 100;
            const y = ((rect.top + rect.height / 2) / window.innerHeight) * 100;
            return `${x}% ${y}%`;
        }

        function extractArticleContent(doc) {
            const fragment = document.createDocumentFragment();
            const articleImg = doc.querySelector('article figure');
            const body = doc.querySelector('article > div');

            if (articleImg) fragment.appendChild(articleImg);
            if (body) fragment.appendChild(body);

            return fragment;
        }

        async function fetchArticleContent(url) {
            const response = await fetch(url);
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            return {
                fragment: extractArticleContent(doc),
                title: doc.querySelector('title')?.textContent || ''
            };
        }

        async function fetchAboutContent(url) {
            const response = await fetch(url);
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');

            const fragment = document.createDocumentFragment();
            const article = doc.querySelector('article');
            if (article) fragment.appendChild(article);

            return {
                fragment,
                title: doc.querySelector('title')?.textContent || ''
            };
        }

        function setX(inner, value, withTransition) {
            inner.style.transition = withTransition
                ? 'transform 250ms ease'
                : 'none';
            inner.style.setProperty('--x', value);
        }

        async function openPopover(urlToOpen, originEl, popoverMode = 'article', fromDOM = false) {
            mode = popoverMode;

            let fragment, title;
            if (fromDOM && popoverMode === 'article') {
                fragment = extractArticleContent(document);
                title = document.title;
            } else if (popoverMode === 'about') {
                ({ fragment, title } = await fetchAboutContent(urlToOpen));
            } else {
                ({ fragment, title } = await fetchArticleContent(urlToOpen));
            }

            content.innerHTML = '';
            content.appendChild(fragment);
            document.title = title;

            const inner = dialog.querySelector('.article-popover__inner');
            inner.style.transformOrigin = getOrigin(originEl);
            inner.style.transition = 'transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1)';
            inner.style.setProperty('--x', '0px');

            history.replaceState({ popover: true, index: currentIndex, mode }, '', urlToOpen);
            dialog.showModal();
            document.body.style.overflow = 'hidden';
        }

        async function navigateTo(newIndex, direction) {
            if (isAnimating) return;
            isAnimating = true;

            const links = getLinks();
            const url = links[newIndex].href;
            const { fragment, title } = await fetchArticleContent(url);

            const inner = dialog.querySelector('.article-popover__inner');
            const outX = direction === 'next' ? '-100vw' : '100vw';
            const inX = direction === 'next' ? '100vw' : '-100vw';

            setX(inner, outX, true);
            await new Promise(resolve => setTimeout(resolve, 300));

            content.innerHTML = '';
            content.appendChild(fragment);
            document.title = title;
            currentIndex = newIndex;
            history.replaceState({ popover: true, index: currentIndex, mode: 'article' }, '', url);

            setX(inner, inX, false);

            await new Promise(resolve => requestAnimationFrame(resolve));
            await new Promise(resolve => requestAnimationFrame(resolve));

            setX(inner, '0px', true);
            await new Promise(resolve => setTimeout(resolve, 300));

            isAnimating = false;
        }

        function navigate(direction) {
            if (mode !== 'article') return;
            const links = getLinks();
            const total = links.length;
            const newIndex = direction === 'next'
                ? (currentIndex + 1) % total
                : (currentIndex - 1 + total) % total;
            navigateTo(newIndex, direction);
        }

        function closePopover() {
            dialog.close();
            document.body.style.overflow = '';
            content.innerHTML = '';
            const inner = dialog.querySelector('.article-popover__inner');
            inner.style.transition = '';
            inner.style.transform = '';
            inner.style.setProperty('--x', '0px');
            document.title = homeTitle;
            history.replaceState(null, '', '/');
        }

        // Ouverture des articles
        document.querySelector('.site-main').addEventListener('click', function (e) {
            const link = e.target.closest('.post-link');
            if (!link) return;
            e.preventDefault();
            const links = getLinks();
            currentIndex = links.indexOf(link);
            const img = link.querySelector('.post-image');
            openPopover(link.href, img, 'article');
        });

        // Ouverture de la page about
        const aboutLink = document.querySelector('.about');
        if (aboutLink) {
            aboutLink.addEventListener('click', function (e) {
                e.preventDefault();
                openPopover(aboutLink.href, aboutLink, 'about');
            });
        }

        // Navigation clavier (articles uniquement)
        window.addEventListener('keydown', function (e) {
            if (!dialog.open) return;
            if (e.key === 'ArrowRight' || e.key === 'k') navigate('next');
            if (e.key === 'ArrowLeft' || e.key === 'j') navigate('prev');
        });

        // Swipe sur mobile
        const inner = dialog.querySelector('.article-popover__inner');
        let touchStartX = null;
        let touchStartY = null;

        inner.addEventListener('touchstart', function (e) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        inner.addEventListener('touchend', function (e) {
            if (touchStartX === null) return;
            const deltaX = e.changedTouches[0].clientX - touchStartX;
            const deltaY = e.changedTouches[0].clientY - touchStartY;
            touchStartX = null;
            touchStartY = null;

            // Ignorer si le geste est principalement vertical (scroll)
            if (Math.abs(deltaY) > Math.abs(deltaX)) return;
            if (Math.abs(deltaX) < 50) return;

            navigate(deltaX < 0 ? 'next' : 'prev');
        }, { passive: true });

        closeBtn.addEventListener('click', function () {
            closePopover();
        });

        dialog.addEventListener('click', function (e) {
            if (e.target === dialog) closePopover();
        });

        window.addEventListener('popstate', function () {
            if (dialog.open) closePopover();
        });

        dialog.addEventListener('close', function () {
            document.body.style.overflow = '';
			content.innerHTML = '';
			const inner = dialog.querySelector('.article-popover__inner');
			inner.style.transition = '';
			inner.style.transform = '';
			inner.style.setProperty('--x', '0px');
			document.title = homeTitle;
			history.replaceState(null, '', '/');
        });

        // Ouverture automatique si on arrive directement sur une URL d'article
        if (window.__openPopover) {
            const { url: postUrl } = window.__openPopover;

            fetch('/')
                .then(r => r.text())
                .then(text => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');
                    const grid = doc.querySelector('.grid');
                    const siteMain = document.querySelector('.site-main');
                    if (grid) siteMain.appendChild(grid);
                })
                .then(() => {
                    openPopover(postUrl, closeBtn, 'article', true);
                });
        }

        // Ouverture automatique si on arrive directement sur la page about
        if (window.__openAbout) {
            const { url: aboutUrl } = window.__openAbout;

            const article = document.querySelector('article');
            const aboutFragment = document.createDocumentFragment();
            if (article) {
            	aboutFragment.appendChild(article.cloneNode(true));
        		article.style.display = 'none';
            };
            const aboutTitle = document.title;

            fetch('/')
                .then(r => r.text())
                .then(text => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');
                    const grid = doc.querySelector('.grid');
                    const siteMain = document.querySelector('.site-main');
                    if (grid) siteMain.appendChild(grid);
                })
                .then(() => {
                    const aboutLink = document.querySelector('.about');
                    content.innerHTML = '';
                    content.appendChild(aboutFragment);
                    document.title = aboutTitle;

                    const inner = dialog.querySelector('.article-popover__inner');
                    inner.style.transformOrigin = getOrigin(aboutLink || closeBtn);
                    inner.style.transition = 'transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1)';
                    inner.style.setProperty('--x', '0px');

                    history.replaceState({ popover: true, index: -1, mode: 'about' }, '', aboutUrl);
                    dialog.showModal();
                    document.body.style.overflow = 'hidden';
                });
        }
    })();
});