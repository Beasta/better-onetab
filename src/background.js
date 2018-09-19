import tabs from './common/tabs'
import storage from './common/storage'
import options from './common/options'
import _ from 'lodash'
import __ from './common/i18n'
import browser from 'webextension-polyfill'
import boss from './common/service/boss'

/* eslint-disable-next-line */
if (DEBUG && !MOZ) import(
  /* webpackChunkName: "autoreload", webpackMode: "lazy" */
  './common/autoreload'
).then(({autoreload}) => autoreload())

if (DEBUG) {
  window.tabs = tabs
  window.browser = browser
}

const getBrowserActionHandler = action => {
  if (action === 'store-selected') return () => tabs.storeSelectedTabs()
  if (action === 'show-list') return () => tabs.openTabLists()
  if (action === 'store-all') return () => tabs.storeAllTabs()
  if (action === 'store-all-in-all-windows') return () => tabs.storeAllTabInAllWindows()
  /* eslint-disable-next-line */
  return () => {}
}

const updateBrowserAction = (action, tmp = false) => {
  if (!tmp) window.currentBrowserAction = action
  /* eslint-disable-next-line */
  if (!window.coverBrowserAction) window.coverBrowserAction = () => {}
  const {items} = _.find(options.optionsList, {name: 'browserAction'})
  const {label} = _.find(items, {value: action})
  console.log('action is: ', action, 'set title as: ', label)
  browser.browserAction.setTitle({title: label})
  if (action === 'popup') {
    browser.browserAction.setPopup({popup: 'index.html#/popup'})
    /* eslint-disable-next-line */
    window.coverBrowserAction = () => {}
  } else {
    browser.browserAction.setPopup({popup: ''})
    window.browswerActionClickedHandler = getBrowserActionHandler(action)
    if (!window.opts.openTabListWhenNewTab) return
    window.coverBrowserAction = async activeInfo => {
      const tab = await browser.tabs.get(activeInfo.tabId)
      if (['about:home', 'about:newtab', 'chrome://newtab/'].includes(tab.url)) {
        updateBrowserAction('show-list', true)
      } else {
        updateBrowserAction(window.currentBrowserAction)
      }
    }
  }
}

const setupContextMenus = async ({pageContext, allContext}) => {
  await browser.contextMenus.removeAll()
  const contexts = [browser.contextMenus.ContextType.BROWSER_ACTION]
  if (pageContext) {
    contexts.push(browser.contextMenus.ContextType.PAGE)
    if (allContext) contexts.push(browser.contextMenus.ContextType.ALL)
  }
  const menus = {
    STORE_SELECTED_TABS: tabs.storeSelectedTabs,
    STORE_ALL_TABS_IN_CURRENT_WINDOW: tabs.storeAllTabs,
    SHOW_TAB_LIST: tabs.openTabLists,
    STORE_ALL_TABS_IN_ALL_WINDOWS: tabs.storeAllTabInAllWindows,
    EXTRA: {
      STORE_LEFT_TABS: tabs.storeLeftTabs,
      STORE_RIGHT_TABS: tabs.storeRightTabs,
      STORE_TWOSIDE_TABS: tabs.storeTwoSideTabs,
    },
  }
  const createMenus = async (obj, parent) => {
    for (const key of Object.keys(obj)) {
      const prop = {
        id: key,
        title: __('menu_' + key),
        contexts,
      }
      if (parent) {
        prop.id = parent + '.' + key
        prop.parentId = parent
      }
      const id = await browser.contextMenus.create(prop)
      console.log('context menu created: ' + id)
      if (_.isObject(obj[key])) await createMenus(obj[key], key)
    }
  }
  window.contextMenusClickedHandler = info => {
    console.log('context menu clicked', info.menuItemId)
    _.get(menus, info.menuItemId)()
  }
  console.groupCollapsed('create context menu', contexts)
  await createMenus(menus)
  console.groupEnd('create context menu')
}

const dynamicDisableMenu = async () => {
  const groupedTabs = await tabs.groupTabsInCurrentWindow()
  browser.contextMenus.update('EXTRA.STORE_LEFT_TABS', {
    enabled: groupedTabs.left.length !== 0,
    title: __('menu_STORE_LEFT_TABS') + ` (${groupedTabs.left.length})`,
  })
  browser.contextMenus.update('EXTRA.STORE_RIGHT_TABS', {
    enabled: groupedTabs.right.length !== 0,
    title: __('menu_STORE_RIGHT_TABS') + ` (${groupedTabs.right.length})`,
  })
  browser.contextMenus.update('EXTRA.STORE_TWOSIDE_TABS', {
    enabled: groupedTabs.twoSide.length !== 0,
    title: __('menu_STORE_TWOSIDE_TABS') + ` (${groupedTabs.twoSide.length})`,
  })
}

const commandHandler = async command => {
  if (command === 'store-selected-tabs') tabs.storeSelectedTabs()
  else if (command === 'store-all-tabs') tabs.storeAllTabs()
  else if (command === 'restore-lastest-list') {
    const lists = await storage.getLists()
    if (lists.length === 0) return true
    const [lastest] = lists
    await tabs.restoreList(lastest)
    if (lastest.pinned) return true
    lists.shift()
    return storage.setLists(lists)
  } else if (command === 'open-lists') tabs.openTabLists()
  else return true
}

const init = async () => {
  const opts = window.opts = await storage.getOptions() || {}
  _.defaults(opts, options.getDefaultOptions())
  await storage.setOptions(opts)
  window.nightmode = opts.defaultNightMode
  updateBrowserAction(opts.browserAction)
  setupContextMenus(opts)
  browser.runtime.onMessage.addListener(async msg => {
    console.log(msg)
    if (msg.optionsChanged) {
      const changes = msg.optionsChanged
      console.log(changes)
      Object.assign(opts, changes)
      if (changes.browserAction) updateBrowserAction(changes.browserAction)
      if (('pageContext' in changes) || ('allContext' in changes)) await setupContextMenus(changes)
      await browser.runtime.sendMessage({optionsChangeHandledStatus: 'success'})
    }
    if (msg.restoreList) {
      const {restoreList} = msg
      const listIndex = restoreList.index
      const lists = await storage.getLists()
      if (restoreList.newWindow) {
        tabs.restoreListInNewWindow(lists[listIndex])
      } else {
        tabs.restoreList(lists[listIndex])
      }
      if (!lists[listIndex].pinned) {
        lists.splice(listIndex, 1)
        storage.setLists(lists)
      }
    }
    if (msg.uploadImmediate) {
      boss.uploadImmediate().catch(() => {
        browser.runtime.sendMessage({uploaded: {error: true}})
      })
    }
    if (msg.forceUpdate) {
      boss.forceUpdate(msg.forceUpdate)
    }
    if (msg.resolveConflict) {
      boss.resolveConflict(msg.resolveConflict)
    }
    if (msg.forceDownload) {
      boss.forceDownloadRemoteImmediate()
    }
  })
  browser.runtime.onMessageExternal.addListener(commandHandler)
  browser.commands.onCommand.addListener(commandHandler)
  browser.runtime.onUpdateAvailable.addListener(detail => {
    window.update = detail.version
  })
  browser.runtime.onInstalled.addListener(detail => {
    if (detail.reason === chrome.runtime.OnInstalledReason.UPDATE) {
      const updatedNotificationId = 'updated'
      browser.notifications.onClicked.addListener(id => {
        if (id === updatedNotificationId) {
          browser.tabs.create({ url: 'https://github.com/cnwangjie/better-onetab/blob/master/CHANGELOG.md' })
        }
      })
      browser.notifications.create(updatedNotificationId, {
        type: 'basic',
        iconUrl: 'assets/icons/icon_128.png',
        title: __('ui_updated_to_ver') + ' v' + browser.runtime.getManifest().version,
        message: __('ui_click_view_changelog'),
      })
      setTimeout(() => {
        browser.notifications.clear(updatedNotificationId)
      }, 5000)
    }
  })
  browser.browserAction.onClicked.addListener(action => window.browswerActionClickedHandler(action))
  browser.contextMenus.onClicked.addListener(info => window.contextMenusClickedHandler(info))
  browser.tabs.onActivated.addListener(_.debounce(activeInfo => {
    window.coverBrowserAction(activeInfo)
    dynamicDisableMenu(activeInfo)
  }, 200))
  browser.storage.onChanged.addListener(changes => {
    console.log(changes)
    if (changes.boss_token) {
      window.boss_token = changes.boss_token
    }
  })
  await boss.forceDownloadRemoteImmediate()
  setInterval(() => boss.forceDownloadRemoteImmediate(), 60 * 1000)
}

init()
