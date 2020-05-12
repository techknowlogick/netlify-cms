import semaphore, { Semaphore } from 'semaphore';
import { stripIndent } from 'common-tags';
import {
  Implementation,
  User,
  Credentials,
  Config,
  asyncLock,
  AsyncLock,
  entriesByFolder,
  runWithLock
} from 'netlify-cms-lib-util';
import AuthenticationPage from './AuthenticationPage';
import API, { API_NAME } from './API';

const MAX_CONCURRENT_DOWNLOADS = 10;

export default class Gitea implements Implementation {
  lock: AsyncLock;
  api: API | null;
  options: {
    proxied: boolean;
    API: API | null;
    initialWorkflowStatus: string;
  };
  repo: string;
  branch: string;
  apiRoot: string;
  token: string | null;
  squashMerges: boolean;
  mediaFolder: string;
  previewContext: string;

  _mediaDisplayURLSem?: Semaphore;

  constructor(config: Config, options = {}) {
    this.options = {
      proxied: false,
      API: null,
      initialWorkflowStatus: '',
      ...options,
    };

    if (
      !this.options.proxied &&
      (config.backend.repo === null || config.backend.repo === undefined)
    ) {
      throw new Error('The Gitea backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;

    this.repo = config.backend.repo || '';
    this.branch = config.backend.branch || 'master';
    this.apiRoot = config.backend.api_root || 'https://gitea.com/api/v1';
    this.token = '';
    this.squashMerges = config.backend.squash_merges || false;
    this.mediaFolder = config.media_folder;
    this.previewContext = config.backend.preview_context || '';
    this.lock = asyncLock();
  }

  isGitBackend() {
    return true;
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user: User) {
    return this.authenticate(user);
  }

  async authenticate(state: Credentials) {
    this.token = state.token as string;
    this.api = new API({
      token: this.token,
      branch: this.branch,
      repo: this.repo,
      apiRoot: this.apiRoot,
      squashMerges: this.squashMerges,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });
    const user = await this.api.user();
    const isCollab = await this.api.hasWriteAccess().catch((error: Error) => {
      error.message = stripIndent`
        Repo "${this.repo}" not found.

        Please ensure the repo information is spelled correctly.

        If the repo is private, make sure you're logged into a Gitea account with access.
      `;
      throw error;
    });

    // Unauthorized user
    if (!isCollab) {
      throw new Error('Your Gitea user account does not have access to this repo.');
    }

    // Authorized user
    return { ...user, login: user.username, token: state.token as string };
  }

  async logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  async getMedia() {
    console.log("getMedia")
    return this.api!.listFiles(this.mediaFolder).then(async files => {
      return await Promise.all(
        files.map(async ({ sha, download_url, path, size, name }) => {
          return { id: sha, name, size, download_url, path };
        }),
      );
    });
  }

  entriesByFolder(path: string, extension: string) {
    console.log(`entriesByFolder: ${path} ${extension}`)
    const listFiles = () =>
      this.api!.listFiles(path, true)

    const readFile = (path: string, id: string | null | undefined) => {
      return this.api!.readFile(path, id) as Promise<string>;
    };
    console.log(listFiles)
    const files = entriesByFolder(
      listFiles,
      readFile,
      ()=>{},
      API_NAME
    );
    return files;
  }

  fetchFiles = (files: any) => {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises: any[] = [];
    files.forEach((file: any) => {
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api!.readFile(file.path, file.sha)
              .then(data => {
                resolve({ file, data });
                sem.leave();
              })
              .catch((err = true) => {
                sem.leave();
                console.error(`failed to load file from Gitea: ${file.path}`);
                resolve({ error: err });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !loadedEntry.error),
    );
  };

  // Fetches a single entry.
  getEntry(path: string) {
    return this.api!.readFile(path).then(data => ({
      file: { path, id: null },
      data: data as string,
    }));
  }

  async persistEntry(entry: Entry, mediaFiles: AssetProxy[], options: PersistOptions) {
    // persistEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.persistFiles(entry, mediaFiles, options),
      'Failed to acquire persist entry lock',
    );
  }

}
