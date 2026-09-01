type KeyPairType = {
    pubKey: Buffer;
    privKey: Buffer;
};
export declare function generateSenderKey(): Buffer;
export declare function generateSenderKeyId(): number;
export interface SigningKeyPair {
    public: Buffer;
    private: Buffer;
}
export declare function generateSenderSigningKey(key?: KeyPairType): SigningKeyPair;
export {};
//# sourceMappingURL=keyhelper.d.ts.map