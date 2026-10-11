"""Preview user-authored messages from assistant exports; persistence stays in context-store."""
import datetime
import hashlib
import json
import re

MAX_EXPORT_BYTES = 1024 * 1024
MAX_CANDIDATES = 100
PAYMENT = re.compile(r'payment|paiement|bank|banque|bancair|carte|card|\botp\b|3.?d.?secure|biometr|confirmation|virement|transaction|checkout|wallet|\bd17\b|flouci|maxit|topnet|clic.?to.?pay|termux.notification|\d+[.,]?\d*\s*(?:eur|usd|tnd|dt|dinar|€|\$)', re.I)
SENSITIVE = re.compile(r'\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|token|password|mot de passe|secret|credential|authorization|bearer|\bcvv\b|\bcvc\b|api[_ -]?key|iban|(?:\d[ -]?){8,19}|(?<!\d)\d{6}(?!\d)|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|https?://|[\w.+-]+@[\w.-]+', re.I)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def stamp(value):
    try:
        if type(value) in (int, float):
            if not 631152000 <= value <= 4102444800: return None
            return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
        if isinstance(value, str) and len(value) <= 40:
            result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if result.tzinfo is None: return None
            if not 1990 <= result.year <= 2100: return None
            return result.astimezone(datetime.timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError): pass
    return None


def preview(source, data):
    if source not in {'chatgpt', 'claude'} or not isinstance(data, list) or len(data) > 50:
        raise ValueError('invalid_memory_export')
    if len(canonical(data).encode()) > MAX_EXPORT_BYTES:
        raise ValueError('memory_export_too_large')
    items, seen, filtered, scanned = [], set(), 0, 0
    for conversation in data:
        if not isinstance(conversation, dict): raise ValueError('invalid_memory_export')
        if source == 'chatgpt':
            mapping = conversation.get('mapping')
            if not isinstance(mapping, dict): raise ValueError('invalid_memory_export')
            messages = [node.get('message') for node in mapping.values() if isinstance(node, dict)]
        else:
            messages = conversation.get('chat_messages')
            if not isinstance(messages, list): raise ValueError('invalid_memory_export')
        if len(messages) > 2000: raise ValueError('memory_export_too_large')
        for message in messages:
            scanned += 1
            if scanned > 5000: raise ValueError('memory_export_too_large')
            if not isinstance(message, dict): continue
            if source == 'chatgpt':
                author = message.get('author')
                content = message.get('content')
                if not isinstance(author, dict) or author.get('role') != 'user' or not isinstance(content, dict) or content.get('content_type') != 'text': continue
                parts = content.get('parts')
                if not isinstance(parts, list) or any(not isinstance(part, str) for part in parts): continue
                text = '\n'.join(parts)
                created = stamp(message.get('create_time'))
            else:
                if message.get('sender') != 'human': continue
                text = message.get('text')
                created = stamp(message.get('created_at'))
            if not isinstance(text, str): continue
            text = ' '.join(text.split())
            if not text or len(text) > 2000 or PAYMENT.search(text) or SENSITIVE.search(text):
                filtered += 1
                continue
            item = {'source':source, 'text':text, 'originalCreatedAt':created, 'kind':'import'}
            identifier = hashlib.sha256(canonical(item).encode()).hexdigest()
            if identifier in seen: continue
            seen.add(identifier)
            items.append({'id':identifier, **item})
            if len(items) > MAX_CANDIDATES: raise ValueError('memory_export_too_large')
    items.sort(key=lambda item: item['id'])
    digest = hashlib.sha256(canonical({'source':source, 'items':items}).encode()).hexdigest()
    return {'success':True, 'state':'preview', 'receipt':None, 'previewHash':digest,
        'items':items, 'filteredCount':filtered, 'writes':False,
        'selectionRequired':True, 'source':source}


def selection(body):
    if not isinstance(body, dict) or set(body) != {'source','export','previewHash','selectedIds','operationId'}:
        raise ValueError('invalid_memory_import')
    operation = body['operationId']
    if not isinstance(operation, str) or not re.fullmatch(r'[-A-Za-z0-9_.:]{1,128}', operation): raise ValueError('invalid_memory_operation')
    result = preview(body['source'], body['export'])
    if body['previewHash'] != result['previewHash']: raise ValueError('memory_preview_changed')
    selected = body['selectedIds']
    if not isinstance(selected, list) or not 1 <= len(selected) <= 20 or any(not isinstance(item, str) or not re.fullmatch('[a-f0-9]{64}',item) for item in selected) or len(set(selected)) != len(selected): raise ValueError('invalid_memory_selection')
    available = {item['id']:item for item in result['items']}
    if any(item not in available for item in selected): raise ValueError('invalid_memory_selection')
    return result, [available[item] for item in sorted(selected)]
