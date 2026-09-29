import jwt from 'jsonwebtoken';
import { config } from '../config.js';
export function buildEditorConfig(params) {
    const { file, user, sharePermissions } = params;
    const platformBaseUrl = config.PLATFORM_BASE_URL;
    // Sign a short-lived token for DS to fetch the file
    const serveToken = jwt.sign({ fileId: file.id }, config.DS_JWT_SECRET, { expiresIn: '1h' });
    const fileExtension = file.name.includes('.')
        ? file.name.split('.').pop()
        : '';
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    const documentType = getDocumentType(fileExtension);
    // Determine permissions: use share permissions if present, otherwise default owner permissions
    const permissions = sharePermissions
        ? {
            edit: sharePermissions.edit,
            download: sharePermissions.download,
            print: sharePermissions.print,
            copy: sharePermissions.copy,
            comment: sharePermissions.comment,
            review: sharePermissions.review,
            chat: sharePermissions.chat,
            fillForms: sharePermissions.fillForms,
        }
        : {
            edit: true,
            download: true,
        };
    // Set mode to "view" when share permissions are present and edit is false
    const mode = sharePermissions && !sharePermissions.edit ? 'view' : 'edit';
    const { sharingSettings, isOwner } = params;
    // Build document.info object with optional sharing metadata
    const info = {};
    if (sharingSettings) {
        info.sharingSettings = sharingSettings;
        if (sharingSettings.length > 0) {
            info.owner = sharingSettings[0].user;
        }
    }
    // Set changeOwner permission: false for non-owners to hide sharing button
    const documentPermissions = { ...permissions };
    if (isOwner === false) {
        documentPermissions.changeOwner = false;
    }
    const editorConfig = {
        documentType,
        document: {
            url: `${platformBaseUrl}/api/files/serve/${serveToken}`,
            title: file.name,
            fileType: fileExtension,
            key: documentKey,
            permissions: documentPermissions,
            ...(Object.keys(info).length > 0 ? { info } : {}),
        },
        editorConfig: {
            mode,
            callbackUrl: `${platformBaseUrl}/api/ds/callback?fileId=${file.id}`,
            user: {
                id: user.id,
                name: user.name,
            },
            customization: {
                forcesave: true,
            },
            ...(params.hasVersions ? {
                events: {
                    onRequestHistory: true,
                    onRequestHistoryData: true,
                    onRequestHistoryClose: true,
                    onRequestRestore: true,
                },
            } : {}),
        },
    };
    // Sign the full config as a token for DS verification
    const token = jwt.sign(editorConfig, config.DS_JWT_SECRET);
    return { ...editorConfig, token };
}
function getDocumentType(ext) {
    if ('doc docx docm dot dotx dotm odt fodt ott rtf txt html htm mht xml pdf djvu fb2 epub xps oxps'.includes(ext))
        return 'word';
    if ('xls xlsx xlsm xlsb xlt xltx xltm ods fods ots csv'.includes(ext))
        return 'cell';
    if ('pps ppsx ppsm ppt pptx pptm pot potx potm odp fodp otp'.includes(ext))
        return 'slide';
    return 'word';
}
//# sourceMappingURL=editorConfig.js.map