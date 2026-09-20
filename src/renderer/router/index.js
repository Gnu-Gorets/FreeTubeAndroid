import { createRouter, createWebHashHistory } from 'vue-router'
import Subscriptions from '../views/Subscriptions/Subscriptions.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'default',
      meta: {
        title: 'Subscriptions'
      },
      component: Subscriptions
    },
    {
      path: '/subscriptions',
      name: 'subscriptions',
      meta: {
        title: 'Subscriptions'
      },
      component: Subscriptions
    },
    {
      path: '/subscribedchannels',
      name: 'subscribedChannels',
      meta: {
        title: 'Channels'
      },
      component: () => import('../views/SubscribedChannels/SubscribedChannels.vue')
    },
    ...(process.env.SUPPORTS_LOCAL_API
      ? [{
          path: '/trending',
          name: 'trending',
          meta: {
            title: 'Trending'
          },
          component: () => import('../views/Trending/Trending.vue')
        }]
      : []),
    {
      path: '/popular',
      name: 'popular',
      meta: {
        title: 'Most Popular'
      },
      component: () => import('../views/Popular/Popular.vue')
    },
    {
      path: '/userplaylists',
      name: 'userPlaylists',
      meta: {
        title: 'Your Playlists'
      },
      component: () => import('../views/UserPlaylists/UserPlaylists.vue')
    },
    {
      path: '/history',
      name: 'history',
      meta: {
        title: 'History'
      },
      component: () => import('../views/History/History.vue')
    },
    ...(process.env.IS_ANDROID
      ? [{
          path: '/downloads',
          name: 'downloads',
          meta: {
            title: 'Downloads'
          },
          component: () => import('../views/Downloads/Downloads.vue')
        }]
      : []),
    {
      path: '/settings',
      name: 'settings',
      meta: {
        title: 'Settings'
      },
      component: () => import('../views/Settings/Settings.vue')
    },
    {
      path: '/about',
      name: 'about',
      meta: {
        title: 'About'
      },
      component: () => import('../views/About/About.vue')
    },
    {
      path: '/settings/profile',
      name: 'profileSettings',
      meta: {
        title: 'Profile Settings'
      },
      component: () => import('../views/ProfileSettings/ProfileSettings.vue')
    },
    {
      path: '/search/:query',
      meta: {
        title: 'Search Results'
      },
      component: () => import('../views/SearchPage/SearchPage.vue')
    },
    {
      path: '/playlist/:id',
      meta: {
        title: 'Playlist'
      },
      component: () => import('../views/Playlist/Playlist.vue')
    },
    {
      path: '/channel/:id/:currentTab?',
      meta: {
        title: 'Channel'
      },
      component: () => import('../views/Channel/Channel.vue')
    },
    {
      path: '/watch/:id',
      meta: {
        title: 'Watch'
      },
      component: () => import('../views/Watch/Watch.vue')
    },
    {
      path: '/hashtag/:hashtag',
      meta: {
        title: 'Hashtag'
      },
      component: () => import('../views/Hashtag/Hashtag.vue')
    },
    {
      path: '/post/:id',
      meta: {
        title: 'Post',
      },
      component: () => import('../views/Post.vue')
    }
  ],
  scrollBehavior(to, from, savedPosition) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (savedPosition !== null) {
          resolve(savedPosition)
        } else {
          resolve({ left: 0, top: 0 })
        }
      }, 500)
    })
  }
})

export default router
