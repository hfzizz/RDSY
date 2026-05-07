import type { DriveFile } from '../types';
import { RDSY_FOLDER_NAME, SIDECAR_SUFFIX } from '../types';

const BASE_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message ?? JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`Drive API error [${context}] ${response.status} ${response.statusText}: ${detail}`);
  }
}

export async function listFiles(accessToken: string, query: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: query,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      pageSize: '1000',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await fetch(`${BASE_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    await assertOk(response, 'listFiles');

    const data = await response.json();
    if (data.files) {
      files.push(...data.files);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

export async function ensureLibraryFolder(accessToken: string): Promise<string> {
  const query = `name='${RDSY_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const existing = await listFiles(accessToken, query);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const metadata = {
    name: RDSY_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
  };

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });
  await assertOk(response, 'ensureLibraryFolder create');

  const folder = await response.json();
  return folder.id as string;
}

export async function listPDFs(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const query = `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`;
  return listFiles(accessToken, query);
}

export async function downloadBlob(accessToken: string, fileId: string): Promise<Blob> {
  const response = await fetch(`${BASE_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, `downloadBlob(${fileId})`);
  return response.blob();
}

export async function downloadJSON<T>(accessToken: string, fileId: string): Promise<T> {
  const response = await fetch(`${BASE_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, `downloadJSON(${fileId})`);
  return response.json() as Promise<T>;
}

export async function uploadPDF(
  accessToken: string,
  folderId: string,
  file: File,
): Promise<DriveFile> {
  const boundary = `rdsy_boundary_${Date.now()}`;
  const metadata = {
    name: file.name,
    mimeType: 'application/pdf',
    parents: [folderId],
  };

  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`;

  const closingBoundary = `\r\n--${boundary}--`;

  const metadataBlob = new Blob([metadataPart], { type: 'text/plain' });
  const contentHeader = new Blob(
    [`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`],
    { type: 'text/plain' },
  );
  const closing = new Blob([closingBoundary], { type: 'text/plain' });

  const body = new Blob([metadataBlob, contentHeader, file, closing]);

  const response = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  await assertOk(response, `uploadPDF(${file.name})`);

  return response.json() as Promise<DriveFile>;
}

export async function upsertJSON(
  accessToken: string,
  folderId: string,
  name: string,
  data: unknown,
  existingId?: string,
): Promise<string> {
  const jsonString = JSON.stringify(data);
  const jsonBlob = new Blob([jsonString], { type: 'application/json' });

  if (existingId) {
    // Update existing file — PATCH to upload endpoint, no parents change
    const boundary = `rdsy_boundary_${Date.now()}`;
    const metadata = { name };

    const metadataPart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n`;

    const contentHeader = `--${boundary}\r\nContent-Type: application/json\r\n\r\n`;
    const closingBoundary = `\r\n--${boundary}--`;

    const body = new Blob([
      new Blob([metadataPart], { type: 'text/plain' }),
      new Blob([contentHeader], { type: 'text/plain' }),
      jsonBlob,
      new Blob([closingBoundary], { type: 'text/plain' }),
    ]);

    const response = await fetch(
      `${UPLOAD_URL}/${existingId}?uploadType=multipart&fields=id`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    await assertOk(response, `upsertJSON update(${name})`);

    const result = await response.json();
    return result.id as string;
  } else {
    // Create new file
    const boundary = `rdsy_boundary_${Date.now()}`;
    const metadata = {
      name,
      mimeType: 'application/json',
      parents: [folderId],
    };

    const metadataPart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n`;

    const contentHeader = `--${boundary}\r\nContent-Type: application/json\r\n\r\n`;
    const closingBoundary = `\r\n--${boundary}--`;

    const body = new Blob([
      new Blob([metadataPart], { type: 'text/plain' }),
      new Blob([contentHeader], { type: 'text/plain' }),
      jsonBlob,
      new Blob([closingBoundary], { type: 'text/plain' }),
    ]);

    const response = await fetch(
      `${UPLOAD_URL}?uploadType=multipart&fields=id`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    await assertOk(response, `upsertJSON create(${name})`);

    const result = await response.json();
    return result.id as string;
  }
}

export async function listSidecars(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const query = `'${folderId}' in parents and name contains '${SIDECAR_SUFFIX}' and trashed=false`;
  return listFiles(accessToken, query);
}
