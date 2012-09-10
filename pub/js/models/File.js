//returns the file model
define(['tools/uploader','models/Chunk','models/Manifest'],function(Uploader, Chunk, Manifest){ 
    return Backbone.Model.extend({

        defaults:{
            /**
             * Stuff that will be instatiated on creation
             *
             * file: File obj
             * reader: FileReader obj
             *
            */

           chunkSize : 1e6 // 10 MB
           , uploadURL: 'api/uploadFile'
           , manifest: {
               fileName:''
               , chunks:[] //array of objects containing the chunkNumber and chunk location
               , chunkSize:0
               , secretKey:''
               , "content-type":''
               , fileSize:''

           }
           , uploader: (new Uploader())
           , encryptor: sjcl.mode.betterCBC

        },

        manifest: new Manifest(),

        initialize: function(){
            this.set('reader',new FileReader());

            var file = this.get('file');


            //Unfortunately somethings have vendor prefixes so we'll get that sorted right here and now
            File.prototype.slice = File.prototype.webkitSlice ? File.prototype.webkitSlice : File.prototype.mozSlice;
        },

        //splits the file into several chunks of size specified by the argument ( in bytes )
        //returns an array of objects in the form of 
        // chunk = [
        //   { start: 0, end: 1024 }
        //   { start: 1025, end: 2048 }
        //   ...
        //]
        split: function(callback) {
            var file = this.get('file');
            var chunkSize = Chunk.prototype.defaults.chunkSize
            var chunkCount = Math.ceil(file.size/chunkSize)
            //see if we need padding
            //32 is becasue the encryption works on a 32 bit array
            //we add one more chunk for padding sake
            if ( (file.size%chunkSize)%32 != 0 )  chunkCount++;
            

            //if (this.has('chunks')) return callback(this.get('chunks'));

            var counter = 0;
            var chunks = [];

            //async call to save chunks
            var saveChunks = _.after(chunkCount, _.bind(function(chunks){ 
                this.set('chunks', chunks);
                this.manifest.setChunks(chunks)
                callback(chunks)
            },this) )


            padding = false
            while ( counter < file.size ){
                var start = counter;
                counter += chunkSize;
                var end = counter < file.size ? counter : file.size;

                if ( (end - start)%32 != 0){
                    leftover = (end - start)%32
                    padding = true;
                    end -= leftover;
                }

                this.getArrayBufferChunk(start, end, function(buffer){
                    chunks.push(new Chunk({buffer:buffer}));
                    saveChunks(chunks)
                })
                
                if (padding){
                    start = end;
                    end = file.size + 32-leftover
                    counter += chunkSize;
                    this.getArrayBufferChunk(start, end, function(buffer){
                        paddedBuffer = new ArrayBuffer(32)

                        buffer1View = new Int8Array(buffer)
                        buffer2View = new Int8Array(paddedBuffer)
                        for (var i = 0; i < buffer1View.length; i++) {
                            buffer2View[i] = buffer1View[i]
                        };

                        chunks.push(new Chunk({buffer:paddedBuffer}));
                        saveChunks(chunks)
                    })
                }

            }

        },

        //Returns the linkName for the manifest and the key
        upload: function(callback){
            //this.split()
            var chunks = this.get('chunks');
            var file = this.get('file');
            var chunkSize = Chunk.prototype.defaults.chunkSize
            var chunkCount = Math.ceil(file.size/chunkSize)



            uploadManifest = _.after(chunks.length, _.bind(this.manifest.uploadManifest, this.manifest, callback) )

            for (var i = 0; i < chunks.length; i++) {
                var chunk = chunks[i]
                chunk.encryptChunk()
                
                //bind the function to this and keep the current index inside to function so it doesn't change when called
                chunk.upload(_.bind(function(index, linkName){
                    //save the response here
                    this.manifest.setChunkLinkName(index, linkName)

                    //async way of knowing when all the chunks have been uploaded, we go on to upload the chunks
                    uploadManifest()

                }, this, i))
            };
        },

        //This will get the binary string from a specified chunknumber from the file
        getBinaryChunk: function(chunkNumber,callback){
            var chunks = this.get('chunks');
            var chunk = chunks[chunkNumber];

            var reader = new FileReader();
            var file = this.get('file');

            reader.onloadend = _.bind(function(event){
                //check if we are done reading the file
                if (event.target.readyState == FileReader.DONE){
                    callback(event.target.result) //call the callback with the binary data
                }

            }, this)

            //get the right chunk
            var blob = file.slice(chunk.start, chunk.end);

            //lets start reading
            reader.readAsBinaryString(blob)
        },

        getArrayBufferChunk:function(start, end, callback){

            var reader = new FileReader();
            var file = this.get('file');

            reader.onloadend = _.bind(function(event){
                //check if we are done reading the file
                if (event.target.readyState == FileReader.DONE){
                    callback(event.target.result) //call the callback with the binary data
                }

            }, this)

            //get the right chunk
            var blob = file.slice(start, end);

            //lets start reading
            reader.readAsArrayBuffer(blob)
        },

        //returns the whole binary string through a callback that should accept a parameter for the binary string data
        getBinary: function(callback){
            var reader = this.get('reader');
            var file = this.get('file');

            reader.onloadend = _.bind(function(event){
                //check if we are done reading the file
                if (event.target.readyState == FileReader.DONE){
                    callback(event.target.result) //call the callback with the binary data
                }

            }, this)

            //lets start reading
            reader.readAsBinaryString(file)
        },

        //read the whole file and return the data url. This should be a useful feature for allowing media to be played on the site
        getDataURL: function(callback){
            var reader = this.get('reader');
            var file = this.get('file');

            reader.onloadend = _.bind(function(event){
                //check if we are done reading the file
                if (event.target.readyState == FileReader.DONE){
                    callback(event.target.result) //call the callback with the binary data
                }

            }, this)

            //lets start reading
            reader.readAsDataURL(file);
        },

        logChunkInManifest: function(chunkNumber, chunkFileName){
            var manifest = this.get('manifest');
            manifest.chunks.push({chunkNumber:chunkNumber,chunkFileName:chunkFileName});
        },

        syncManifest: function(){
            var file = this.get('file');
            var manifest = this.get('manifest');

            manifest.fileName = file.name;
            manifest.fileSize = file.size;
            manifest.contentType = file.type;
            manifest.chunkSize = this.get('chunkSize');
            manifest.secretKey = this.getKey();

            this.set('manifest',manifest);

            console.log('key is ready, and manifest is synced');

        },

        //Generates the encryption key, returns false if not ready
        generateKey: function(){
            if (this.has('key')) return true;
            if (sjcl.random.isReady()){
                this.set("key",sjcl.random.randomWords(4));

                console.log('triggering keyReady')
                this.trigger('keyReady');
                return true;
            }
            setTimeout(this.generateKey, 1e3) 
        },

        /*
         * Encodes the key along with the iv
         * The first for items in the array are the iv
         */
        encodeKey: function(key){
            return sjcl.codec.base64.toBits(this.iv.concat(key))
        },

        /* Sets the internal iv and returns the decoded key
         * The first four items belong to the iv
         * The last four is the key
         */
        decodeKey: function(encodedKey){
            var ivKey = sjcl.code.base64.fromBits(key);

            this.iv = ivKey.slice(0,4);
            return ivKey.slice(4);
            
            
            
        },

        //Returns a base 64 representation of the key
        getKey: function() {
            var key = this.get('key');


            key = this.encodeKey(key)

            return key;
        },

        //interpretes a base 64 representation of the key
        setKey: function(key){
            this.set('key', this.encryptor.decodeKey(key))
        },

        //Decrypts given binary
        decryptBinary: function(encryptedData){
            return sjcl.decrypt(this.get('key'), encryptedData)
        },

        //encrypt given binary
        encryptBinary: function(binaryString){
            if (this.has('key')){
                return sjcl.encrypt(this.get('key'), binaryString)
            }

            console.error('no encryption key set');
        },

        encryptBinaryChunk: function(chunkNumber, callback){
            if (chunkNumber > this.get('chunks').length){
                return "Error, chunk number out of range";
            }
            var encryptedData = '';

            this.getBinaryChunk(chunkNumber, _.bind(function(data){
                encryptedData = this.encryptBinary(data);
                callback(encryptedData);
            },this) )
        },

        uploadBinary: function(binaryData, fileName, callback){
            var uploader = this.get('uploader');
            uploader.send(this.get('uploadURL'), binaryData, fileName, callback)
        },

        getRandomFileName: function(){
            return sjcl.codec.base64.fromBits(sjcl.random.randomWords(8));
        },

        /* 
         *  This high level function 
         *
         *  splits the file into manageable chunks,
         *  encrypts the chunks,
         *  uploads the encrypted chunks and stores the chunk locations 
         *  and chunk info in the private manifest
         *  
         *
         */

        /*
        upload: function(){
            var chunks = this.split();
            var manifest = this.get('manifest');

            var complete = _.after(chunks.length, _.bind( this.trigger, this, 'uploadComplete') )  //async event trigger to be executed when all the chunks have been uploaded


            _.each(chunks, function(chunk, chunkNumber){

                this.encryptBinaryChunk(chunkNumber, _.bind(function(encryptedData){

                    //create a random file name for the chunk to live under
                    var randomFileName = this.getRandomFileName();

                    this.uploadBinary(encryptedData,randomFileName,_.bind(function(response){
                        //Check to see if the response is successful
                        response = JSON.parse(response);
                        if (response.return == "success"){
                        
                            //log the chunk in the manifest
                            this.logChunkInManifest(chunkNumber, randomFileName);

                        }else{
                            console.error("error in uploading file", response);
                        }

                        //done with this chain

                    },this))

                },this))

            }, this)
        }
       */


    })
});


