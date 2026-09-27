import test from 'node:test';
import assert from 'node:assert/strict';
import { USyncQuery, USyncUser } from '../lib/WAUSync/index.js';

/*
 * parseUSyncQueryResult hands each protocol parser the <bot> element itself, but
 * UsyncBotProfileProtocol.parser then did getBinaryNodeChild(node, 'bot') — a
 * <bot> child of a <bot>, which is always undefined — and dereferenced
 * profile.attrs. The TypeError propagated out of the listNode.content reduce,
 * so withBotProfileProtocol() (exported public API) discarded *every* user in
 * the query, not just the bot ones.
 */

const str = content => ({ content });

const botNode = ({ personaId, name, isDefault = false }) => ({
    tag: 'bot',
    attrs: {},
    content: [{
        tag: 'profile',
        attrs: { v: '1', persona_id: personaId },
        content: [
            { tag: 'name', ...str(name) },
            ...(isDefault ? [{ tag: 'default', attrs: {} }] : []),
            { tag: 'description', ...str(`${name} description`) },
            { tag: 'category', ...str('productivity') },
            { tag: 'attributes', ...str('verified') },
            {
                tag: 'commands',
                attrs: {},
                content: [
                    { tag: 'description', ...str('all commands') },
                    { tag: 'command', content: [{ tag: 'name', ...str('summarise') }, { tag: 'description', ...str('summarise a chat') }] }
                ]
            },
            {
                tag: 'prompts',
                attrs: {},
                content: [{ tag: 'prompt', content: [{ tag: 'emoji', ...str('\u2764') }, { tag: 'text', ...str('help me') }] }]
            }
        ]
    }]
});

const userNode = (jid, bot) => ({ tag: 'user', attrs: { jid }, content: [bot] });

const resultFor = users => ({
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }]
});

const twoBotQuery = () => new USyncQuery()
    .withBotProfileProtocol()
    .withUser(new USyncUser().withPersonaId('p1'))
    .withUser(new USyncUser().withPersonaId('p2'));

test('a two-user bot query returns both users', () => {
    const parsed = twoBotQuery().parseUSyncQueryResult(resultFor([
        userNode('1111111111@bot', botNode({ personaId: 'p1', name: 'One' })),
        userNode('2222222222@bot', botNode({ personaId: 'p2', name: 'Two' }))
    ]));

    assert.equal(parsed.list.length, 2);
    assert.deepEqual(parsed.list.map(e => e.id), ['1111111111@bot', '2222222222@bot']);
});

test('the bot profile payload is parsed off the <bot> element', () => {
    const parsed = twoBotQuery().parseUSyncQueryResult(resultFor([
        userNode('1111111111@bot', botNode({ personaId: 'p1', name: 'One', isDefault: true })),
        userNode('2222222222@bot', botNode({ personaId: 'p2', name: 'Two' }))
    ]));

    const [first, second] = parsed.list;
    assert.equal(first.bot.personaId, 'p1');
    assert.equal(first.bot.name, 'One');
    assert.equal(first.bot.description, 'One description');
    assert.equal(first.bot.category, 'productivity');
    assert.equal(first.bot.attributes, 'verified');
    assert.equal(first.bot.isDefault, true);
    assert.equal(first.bot.commandsDescription, 'all commands');
    assert.deepEqual(first.bot.commands, [{ name: 'summarise', description: 'summarise a chat' }]);
    assert.deepEqual(first.bot.prompts, ['\u2764 help me']);
    assert.equal(second.bot.personaId, 'p2');
    assert.equal(second.bot.isDefault, false);
});

test('a bot query mixed with a second protocol keeps every user', () => {
    const parsed = new USyncQuery()
        .withBotProfileProtocol()
        .withContactProtocol()
        .withUser(new USyncUser().withPersonaId('p1'))
        .parseUSyncQueryResult(resultFor([
            userNode('1111111111@bot', botNode({ personaId: 'p1', name: 'One' })),
            { tag: 'user', attrs: { jid: '628123456789@s.whatsapp.net' }, content: [{ tag: 'contact', attrs: { type: 'in' } }] }
        ]));

    assert.equal(parsed.list.length, 2);
    assert.equal(parsed.list[0].bot.personaId, 'p1');
    assert.equal(parsed.list[1].contact, true);
});

test('a bot with no profile children does not throw', () => {
    const parsed = new USyncQuery()
        .withBotProfileProtocol()
        .withUser(new USyncUser().withPersonaId('p1'))
        .parseUSyncQueryResult(resultFor([
            userNode('1111111111@bot', { tag: 'bot', attrs: {}, content: [] })
        ]));

    assert.equal(parsed.list.length, 1);
    assert.equal(parsed.list[0].bot.personaId, undefined);
    assert.deepEqual(parsed.list[0].bot.commands, []);
    assert.deepEqual(parsed.list[0].bot.prompts, []);
});
